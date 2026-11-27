import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError, twilioErrorMessage } from '../lib/errors';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { twilioClient } from '../twilio/client';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { noteOperatorReply } from '../lib/serialize';
import { emitEphemeral } from '../realtime/io';

export const templatesRouter = Router();

/**
 * WhatsApp template messages (Twilio Content API).
 *
 * Templates are the ONLY way to message someone outside the 24-hour customer
 * service window — a new contact, or one who last wrote more than 24h ago.
 * WhatsApp rejects free-form text there, so this path deliberately does NOT
 * perform the window check that api/messages.ts does.
 *
 * Templates are created here (or in the Twilio Content Template Builder), then
 * submitted to Meta for approval. Only approved ones can be sent.
 */

export interface TemplateVariable {
  /** Placeholder number as it appears in the body, e.g. "1" for {{1}}. */
  key: string;
  /** Twilio's sample value for the placeholder — shown as the input's example. */
  example: string;
}

export interface TemplateOut {
  sid: string;
  friendlyName: string;
  language: string;
  body: string;
  variables: TemplateVariable[];
  category: string | null;
  /** 'approved' | 'pending' | 'rejected' | 'unsubmitted' | … */
  status: string;
  /** Meta's reason when status is 'rejected'. */
  rejectionReason: string | null;
  /** The WhatsApp template name it was submitted under. */
  approvalName: string | null;
  /** 'text' | 'quick-reply' | 'call-to-action' | 'media' | … (the Content type, without "twilio/"). */
  kind: string;
  /** Button labels / actions, for preview and duplication. */
  actions: Array<{ type: string; title: string; value?: string }>;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Pull the human-readable body out of the Content `types` map.
 *
 * A Content resource holds one entry per channel format — `twilio/text`,
 * `twilio/media`, `twilio/quick-reply` and so on — each with its own shape. We
 * prefer plain text, then fall back to whichever type carries a `body`, so a
 * media or quick-reply template still previews as something meaningful rather
 * than blank.
 */
function extractBody(types: Record<string, unknown> | null | undefined): string {
  if (!types) return '';
  const text = types['twilio/text'] as { body?: string } | undefined;
  if (typeof text?.body === 'string') return text.body;
  for (const value of Object.values(types)) {
    const body = (value as { body?: unknown } | null)?.body;
    if (typeof body === 'string') return body;
  }
  return '';
}

/**
 * Read the approval state. Twilio has moved this field around between Content
 * API versions and nests it per channel in some responses, so check the places
 * it is known to appear rather than trusting one shape. Unknown reads as
 * 'unsubmitted', which the UI shows as not-sendable — the safe direction.
 */
function extractApproval(raw: unknown): {
  status: string;
  category: string | null;
  rejectionReason: string | null;
  name: string | null;
} {
  type Node = { status?: unknown; category?: unknown; rejection_reason?: unknown; name?: unknown };
  const a = raw as (Node & { whatsapp?: Node }) | null | undefined;
  const node = a?.whatsapp ?? a;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const status = typeof node?.status === 'string' ? node.status.toLowerCase() : 'unsubmitted';
  return {
    status,
    category: str(node?.category),
    rejectionReason: str(node?.rejection_reason),
    name: str(node?.name),
  };
}

/** Which Content type a template is, and its buttons/actions. */
function extractKind(types: Record<string, unknown> | null | undefined): {
  kind: string;
  actions: TemplateOut['actions'];
} {
  if (!types) return { kind: 'text', actions: [] };
  const keys = Object.keys(types);
  const preferred = keys.find((k) => k !== 'twilio/text') ?? keys[0] ?? 'twilio/text';
  const node = types[preferred] as { actions?: unknown } | undefined;
  const actions = Array.isArray(node?.actions)
    ? (node!.actions as Array<Record<string, unknown>>).map((a) => ({
        type: String(a.type ?? 'QUICK_REPLY'),
        title: String(a.title ?? ''),
        value: a.url ? String(a.url) : a.phone ? String(a.phone) : a.id ? String(a.id) : undefined,
      }))
    : [];
  return { kind: preferred.replace(/^twilio\//, ''), actions };
}

/** Placeholders Twilio declares for a template, as {"1": "Customer_Name"}. */
function extractVariables(vars: Record<string, unknown> | null | undefined): TemplateVariable[] {
  if (!vars) return [];
  return Object.entries(vars)
    .map(([key, example]) => ({ key, example: String(example ?? '') }))
    // Numeric order: Object.keys gives "1","10","2" lexically, which would show
    // the variable inputs out of order in the fill form.
    .sort((a, b) => Number(a.key) - Number(b.key));
}

/** Substitute {{n}} placeholders so we can store/preview what was actually sent. */
export function renderTemplate(body: string, variables: Record<string, string>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => variables[key] ?? match);
}

// Twilio's Content list is a slow call and templates change rarely, so it is
// cached process-wide. Short enough that a newly approved template shows up
// without a redeploy.
const CACHE_MS = 5 * 60 * 1000;
let cache: { at: number; templates: TemplateOut[] } | null = null;

export async function loadTemplates(force = false): Promise<TemplateOut[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.templates;

  const rows = await twilioClient.content.v1.contentAndApprovals.list({ limit: 200 });
  const templates: TemplateOut[] = rows.map((r) => {
    const { status, category, rejectionReason, name } = extractApproval(r.approvalRequests);
    const { kind, actions } = extractKind(r.types as Record<string, unknown>);
    return {
      sid: r.sid,
      friendlyName: r.friendlyName,
      language: r.language,
      body: extractBody(r.types as Record<string, unknown>),
      variables: extractVariables(r.variables as Record<string, unknown>),
      category,
      status,
      rejectionReason,
      approvalName: name,
      kind,
      actions,
      createdAt: r.dateCreated ? new Date(r.dateCreated).toISOString() : null,
      updatedAt: r.dateUpdated ? new Date(r.dateUpdated).toISOString() : null,
    };
  });
  // Quick-reply chips made by the in-chat 🔘 button are internal plumbing, not templates.
  templates.splice(0, templates.length, ...templates.filter((t) => !/^qr_[0-9a-f]{16}$/.test(t.friendlyName)));

  cache = { at: Date.now(), templates };
  return templates;
}

/**
 * GET /api/templates — list the account's content templates.
 *
 * Returns ALL of them with their approval status, not just approved ones: an
 * operator whose template is still pending needs to see that it exists and is
 * waiting, otherwise an empty list looks like the feature is broken.
 * `?refresh=1` bypasses the cache, for right after an approval lands.
 */
templatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    let templates: TemplateOut[];
    try {
      templates = await loadTemplates(req.query.refresh === '1');
    } catch (err) {
      logger.error({ err }, 'failed to list Twilio content templates');
      throw new ApiError(
        502,
        'TEMPLATES_UNAVAILABLE',
        'Could not load templates from Twilio. Check the account credentials and try again.',
      );
    }

    res.json({
      templates,
      approvedCount: templates.filter((t) => t.status === 'approved').length,
    });
  }),
);

const sendSchema = z.object({
  conversationId: z.string().min(1),
  contentSid: z.string().min(1),
  // Keyed by placeholder number: { "1": "Yossi" }.
  variables: z.record(z.string(), z.string().max(500)).default({}),
});

/**
 * POST /api/templates/send — send an approved template to a conversation.
 *
 * No 24h window check: bypassing that window is the entire purpose of a
 * template. Sending one does NOT reopen the window either — only an inbound
 * message from the customer does that, so `lastInboundAt` is left alone.
 */
templatesRouter.post(
  '/send',
  asyncHandler(async (req, res) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid template send payload.');
    const { conversationId, contentSid, variables } = parsed.data;

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    const template = (await loadTemplates()).find((t) => t.sid === contentSid);
    if (!template) throw new ApiError(404, 'NOT_FOUND', 'Template not found.');
    if (template.status !== 'approved') {
      throw new ApiError(
        409,
        'TEMPLATE_NOT_APPROVED',
        `This template is "${template.status}". WhatsApp only delivers approved templates.`,
      );
    }

    // Every declared placeholder must have a value, or the customer receives a
    // message with a literal "{{1}}" in it.
    const missing = template.variables.filter((v) => !variables[v.key]?.trim()).map((v) => v.key);
    if (missing.length) {
      throw new ApiError(
        400,
        'MISSING_VARIABLES',
        `Fill in every field before sending (missing: ${missing.map((m) => `{{${m}}}`).join(', ')}).`,
      );
    }

    const clientId = `c_${crypto.randomUUID()}`;
    const statusCallbackUrl = `${env.PUBLIC_BASE_URL}/webhooks/twilio/status`;

    let sid: string;
    try {
      const sent = await twilioClient.messages.create({
        from: env.TWILIO_WHATSAPP_SENDER,
        to: `whatsapp:${conv.contact.phoneNumber}`,
        contentSid,
        contentVariables: JSON.stringify(variables),
        statusCallback: statusCallbackUrl,
      });
      sid = sent.sid;
    } catch (err) {
      const e = err as { code?: string | number; message?: string };
      logger.error({ err, conversationId, contentSid }, 'template send failed');
      const friendly = twilioErrorMessage(e.code ? String(e.code) : undefined);
      const detail = e.code ? ` [Twilio ${e.code}: ${e.message ?? ''}]` : '';
      throw new ApiError(502, 'TWILIO_SEND_FAILED', `${friendly}${detail}`);
    }

    // Store the RENDERED text, not the raw template: the thread should show what
    // the customer actually received, not "Hi {{1}}".
    const body = renderTemplate(template.body, variables);
    const now = new Date();

    const message = await withOutbox(async (tx, emit) => {
      const m = await tx.message.create({
        data: {
          conversationId: conv.id,
          twilioSid: sid,
          clientId,
          direction: 'outbound',
          type: 'text',
          status: 'sent',
          body,
          sentAt: now,
        },
      });
      // lastMessageAt only — a template does NOT open the 24h window.
      await tx.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: now } });
      await emit({
        kind: 'message.added',
        conversationId: conv.id,
        payload: {
          messageId: m.id,
          clientId: m.clientId,
          direction: 'outbound',
          type: 'text',
          status: m.status,
          body: m.body,
          sentAt: m.sentAt,
        },
      });
      return m;
    });

    await noteOperatorReply(conv.id);
    await prisma.auditEvent.create({
      data: {
        userId: req.session.userId ?? null,
        kind: 'template.sent',
        payload: { conversationId: conv.id, contentSid, friendlyName: template.friendlyName },
      },
    });

    res.json({
      message: {
        id: message.id,
        clientId: message.clientId,
        twilioSid: message.twilioSid,
        direction: 'outbound',
        type: 'text',
        status: message.status,
        body: message.body,
        sentAt: message.sentAt,
      },
    });
  }),
);


// ===== Template management: create / duplicate / submit / delete =====

/** Call the Content API with a JSON body. client.request() never throws on 4xx, so check by hand. */
async function contentApi(method: 'get' | 'post' | 'delete', uri: string, data?: object) {
  let res: { statusCode: number; body: unknown };
  try {
    res = await twilioClient.request({
      method,
      uri,
      ...(data !== undefined && { headers: { 'Content-Type': 'application/json' }, data }),
    });
  } catch (err) {
    logger.error({ err, uri }, 'Twilio Content API unreachable');
    throw new ApiError(502, 'TWILIO_UNREACHABLE', 'Could not reach Twilio. Try again.');
  }
  const body = (typeof res.body === 'string' ? safeJson(res.body) : res.body) as
    | { message?: string; code?: number }
    | null;
  if (res.statusCode >= 300) {
    logger.warn({ status: res.statusCode, body, uri }, 'Twilio Content API rejected request');
    throw new ApiError(
      res.statusCode === 404 ? 404 : 400,
      'TWILIO_REJECTED',
      `Twilio: ${body?.message ?? `request failed (${res.statusCode})`}`,
    );
  }
  return body as Record<string, unknown> | null;
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** WhatsApp template names: lowercase letters, digits and underscores. */
function toApprovalName(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 512) || `template_${Date.now()}`
  );
}

const actionSchema = z.object({
  type: z.enum(['QUICK_REPLY', 'URL', 'PHONE_NUMBER']),
  title: z.string().trim().min(1).max(25),
  value: z.string().trim().max(2000).optional(),
});

const createSchema = z.object({
  friendlyName: z.string().trim().min(1).max(200),
  language: z.string().trim().min(2).max(10).default('he'),
  body: z.string().min(1).max(1024),
  /** Sample value for each {{n}} — Meta reviews the template with these. */
  variables: z.record(z.string(), z.string().max(200)).default({}),
  actions: z.array(actionSchema).max(10).default([]),
  /** Submit to WhatsApp right away. */
  submit: z.boolean().default(false),
  category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION']).default('UTILITY'),
  approvalName: z.string().max(512).optional(),
});

/**
 * POST /api/templates — create a template (optionally submitting it for approval).
 *
 * Kind follows from the actions: none → text, quick replies → quick-reply,
 * URL / phone → call-to-action. "Duplicate" in the UI is this same call with
 * the original's fields pre-filled.
 */
templatesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError(400, 'BAD_INPUT', parsed.error.issues[0]?.message ?? 'Invalid template.');
    }
    const t = parsed.data;

    // Every {{n}} needs a sample value or Meta rejects the template outright.
    const placeholders = [...new Set([...t.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => m[1]!))];
    const missing = placeholders.filter((k) => !t.variables[k]?.trim());
    if (missing.length) {
      throw new ApiError(400, 'MISSING_SAMPLES', `Give an example value for ${missing.map((k) => `{{${k}}}`).join(', ')}.`);
    }

    const quick = t.actions.filter((a) => a.type === 'QUICK_REPLY');
    const cta = t.actions.filter((a) => a.type !== 'QUICK_REPLY');
    if (quick.length && cta.length) {
      throw new ApiError(400, 'MIXED_BUTTONS', 'Use either quick-reply buttons or link/phone buttons, not both.');
    }
    for (const a of cta) {
      if (!a.value) throw new ApiError(400, 'BAD_INPUT', `Button "${a.title}" needs a ${a.type === 'URL' ? 'link' : 'phone number'}.`);
    }

    let types: Record<string, unknown>;
    if (quick.length) {
      types = {
        'twilio/quick-reply': { body: t.body, actions: quick.map((a, i) => ({ title: a.title, id: `btn_${i + 1}` })) },
        'twilio/text': { body: t.body },
      };
    } else if (cta.length) {
      types = {
        'twilio/call-to-action': {
          body: t.body,
          actions: cta.map((a) =>
            a.type === 'URL' ? { type: 'URL', title: a.title, url: a.value } : { type: 'PHONE_NUMBER', title: a.title, phone: a.value },
          ),
        },
        'twilio/text': { body: t.body },
      };
    } else {
      types = { 'twilio/text': { body: t.body } };
    }

    const created = await contentApi('post', 'https://content.twilio.com/v1/Content', {
      friendly_name: t.friendlyName,
      language: t.language,
      variables: Object.fromEntries(placeholders.map((k) => [k, t.variables[k]!])),
      types,
    });
    const sid = String(created?.sid ?? '');
    if (!sid) throw new ApiError(502, 'TWILIO_REJECTED', 'Twilio did not return the new template.');

    let submitError: string | null = null;
    if (t.submit) {
      try {
        await submitForApproval(sid, t.approvalName || t.friendlyName, t.category);
      } catch (err) {
        submitError = err instanceof Error ? err.message : 'Submit failed.';
      }
    }
    await loadTemplates(true).catch(() => undefined);
    emitEphemeral('library.changed', null, { kind: 'templates' });
    res.status(201).json({ sid, submitted: t.submit && !submitError, submitError });
  }),
);

async function submitForApproval(sid: string, name: string, category: string) {
  await contentApi('post', `https://content.twilio.com/v1/Content/${encodeURIComponent(sid)}/ApprovalRequests/whatsapp`, {
    name: toApprovalName(name),
    category,
  });
}

/** POST /api/templates/:sid/submit — send an existing template to Meta for approval. */
templatesRouter.post(
  '/:sid/submit',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        name: z.string().max(512).optional(),
        category: z.enum(['UTILITY', 'MARKETING', 'AUTHENTICATION']).default('UTILITY'),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid category.');
    const sid = req.params.sid!;
    const t = (await loadTemplates()).find((x) => x.sid === sid);
    await submitForApproval(sid, parsed.data.name || t?.friendlyName || sid, parsed.data.category);
    await loadTemplates(true).catch(() => undefined);
    emitEphemeral('library.changed', null, { kind: 'templates' });
    res.json({ ok: true });
  }),
);

/** DELETE /api/templates/:sid — delete from Twilio (and its WhatsApp approval). */
templatesRouter.delete(
  '/:sid',
  asyncHandler(async (req, res) => {
    await contentApi('delete', `https://content.twilio.com/v1/Content/${encodeURIComponent(req.params.sid!)}`);
    await loadTemplates(true).catch(() => undefined);
    emitEphemeral('library.changed', null, { kind: 'templates' });
    res.json({ ok: true });
  }),
);

// ===== Background watcher: tell the operator when Meta decides =====

let watcher: NodeJS.Timeout | null = null;
const lastStatus = new Map<string, string>();

/**
 * Every 10 minutes, re-read template statuses. When one changes (typically
 * pending → approved / rejected) an ephemeral `template.status` ping is pushed
 * so the UI can show a toast — no need to keep refreshing by hand.
 */
export function startTemplateWatcher(): void {
  if (watcher) return;
  const tick = async () => {
    try {
      const list = await loadTemplates(true);
      for (const t of list) {
        const prev = lastStatus.get(t.sid);
        if (prev && prev !== t.status) {
          emitEphemeral('template.status', null, {
            sid: t.sid,
            friendlyName: t.friendlyName,
            from: prev,
            to: t.status,
            rejectionReason: t.rejectionReason,
          });
        }
        lastStatus.set(t.sid, t.status);
      }
    } catch (err) {
      logger.debug({ err }, 'template watcher tick failed');
    }
  };
  setTimeout(() => void tick(), 15_000);
  watcher = setInterval(() => void tick(), 10 * 60 * 1000);
}
