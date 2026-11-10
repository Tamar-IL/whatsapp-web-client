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

export const templatesRouter = Router();

/**
 * WhatsApp template messages (Twilio Content API).
 *
 * Templates are the ONLY way to message someone outside the 24-hour customer
 * service window — a new contact, or one who last wrote more than 24h ago.
 * WhatsApp rejects free-form text there, so this path deliberately does NOT
 * perform the window check that api/messages.ts does.
 *
 * Templates cannot be created from here. They are written in the Twilio Content
 * Template Builder and must be approved by Meta before they can be sent; this
 * only lists what already exists and sends it.
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
function extractApproval(raw: unknown): { status: string; category: string | null } {
  const a = raw as
    | { status?: unknown; category?: unknown; whatsapp?: { status?: unknown; category?: unknown } }
    | null
    | undefined;
  const node = a?.whatsapp ?? a;
  const status = typeof node?.status === 'string' ? node.status.toLowerCase() : 'unsubmitted';
  const category = typeof node?.category === 'string' ? node.category : null;
  return { status, category };
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

async function loadTemplates(force = false): Promise<TemplateOut[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.templates;

  const rows = await twilioClient.content.v1.contentAndApprovals.list({ limit: 200 });
  const templates: TemplateOut[] = rows.map((r) => {
    const { status, category } = extractApproval(r.approvalRequests);
    return {
      sid: r.sid,
      friendlyName: r.friendlyName,
      language: r.language,
      body: extractBody(r.types as Record<string, unknown>),
      variables: extractVariables(r.variables as Record<string, unknown>),
      category,
      status,
    };
  });

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
