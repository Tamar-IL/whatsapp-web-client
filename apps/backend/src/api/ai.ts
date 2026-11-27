import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { getSettings } from '../lib/settings';
import type { Prisma } from '@prisma/client';
import { askAssistant, blockedReason, decide, errorText, listModels, testConnection } from '../lib/aiAgent';
import { SECRET_MASK, maskAction, testAction } from '../lib/aiActions';
import { emitEphemeral } from '../realtime/io';

export const aiRouter = Router();

function cfgOut(c: Awaited<ReturnType<typeof prisma.aiChatConfig.findUnique>>, defaultMode: string) {
  return {
    enabled: c?.enabled ?? false,
    mode: c?.mode ?? defaultMode,
    instructions: c?.instructions ?? '',
    customerInfo: c?.customerInfo ?? '',
    rangeType: c?.rangeType ?? 'always',
    activeFrom: c?.activeFrom ?? null,
    activeUntil: c?.activeUntil ?? null,
    useBusinessHours: c?.useBusinessHours ?? 'any',
    maxRepliesPerDay: c?.maxRepliesPerDay ?? null,
  };
}

/** GET /api/ai/chats — every chat with an agent configuration (for the overview list). */
aiRouter.get(
  '/chats',
  asyncHandler(async (_req, res) => {
    const s = await getSettings();
    const rows = await prisma.aiChatConfig.findMany({
      include: { conversation: { include: { contact: true } } },
      orderBy: { updatedAt: 'desc' },
    });
    res.json({
      chats: await Promise.all(
        rows.map(async (r) => ({
          conversationId: r.conversationId,
          name: r.conversation.contact.displayName ?? r.conversation.contact.profileName ?? r.conversation.contact.phoneNumber,
          ...cfgOut(r, s.ai.defaultMode),
          blocked: await blockedReason(r.conversationId, s),
        })),
      ),
    });
  }),
);

aiRouter.get(
  '/chats/:conversationId',
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    const id = req.params.conversationId!;
    const c = await prisma.aiChatConfig.findUnique({ where: { conversationId: id } });
    const sentToday = await prisma.message.count({
      where: { conversationId: id, origin: 'ai', sentAt: { gt: new Date(Date.now() - 24 * 3600 * 1000) } },
    });
    res.json({ config: cfgOut(c, s.ai.defaultMode), blocked: await blockedReason(id, s), sentToday });
  }),
);

const cfgSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['auto', 'suggest']),
  instructions: z.string().max(8000),
  customerInfo: z.string().max(8000),
  rangeType: z.enum(['always', 'temporary']),
  activeFrom: z.string().datetime().nullable(),
  activeUntil: z.string().datetime().nullable(),
  useBusinessHours: z.enum(['any', 'inside', 'outside']),
  maxRepliesPerDay: z.number().int().min(1).max(1000).nullable(),
});

aiRouter.put(
  '/chats/:conversationId',
  asyncHandler(async (req, res) => {
    const id = req.params.conversationId!;
    const parsed = cfgSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', parsed.error.issues[0]?.message ?? 'Invalid AI settings.');
    const p = parsed.data;
    const from = p.activeFrom ? new Date(p.activeFrom) : null;
    const until = p.activeUntil ? new Date(p.activeUntil) : null;
    if (p.rangeType === 'temporary' && !until) {
      throw new ApiError(400, 'BAD_RANGE', 'A temporary range needs an end date.');
    }
    if (from && until && until <= from) throw new ApiError(400, 'BAD_RANGE', 'The end must be after the start.');
    const conv = await prisma.conversation.findUnique({ where: { id }, select: { id: true } });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Chat not found.');
    const data = { ...p, activeFrom: from, activeUntil: until };
    await withOutbox(async (tx, emit) => {
      await tx.aiChatConfig.upsert({ where: { conversationId: id }, create: { conversationId: id, ...data }, update: data });
      await emit({ kind: 'conversation.updated', conversationId: id, payload: { ai: true } });
    });
    const s = await getSettings();
    const c = await prisma.aiChatConfig.findUnique({ where: { conversationId: id } });
    res.json({ config: cfgOut(c, s.ai.defaultMode), blocked: await blockedReason(id, s) });
  }),
);

/**
 * POST /api/ai/chats/:conversationId/draft — ask the AI what it would answer
 * now, WITHOUT sending. Works in any chat (agent on or off), so it doubles as
 * a "✨ write a reply for me" button and as a test of the chat's instructions.
 */
aiRouter.post(
  '/chats/:conversationId/draft',
  asyncHandler(async (req, res) => {
    const extra = typeof req.body?.instruction === 'string' ? req.body.instruction.slice(0, 1000) : undefined;
    try {
      const decision = await decide(req.params.conversationId!, { extraInstruction: extra });
      res.json({ decision });
    } catch (err) {
      throw new ApiError(502, 'AI_FAILED', errorText(err));
    }
  }),
);

aiRouter.post(
  '/test',
  asyncHandler(async (_req, res) => {
    try {
      res.json(await testConnection());
    } catch (err) {
      throw new ApiError(502, 'AI_FAILED', errorText(err));
    }
  }),
);

/** GET /api/ai/models — chat models this OpenAI key can use. */
aiRouter.get(
  '/models',
  asyncHandler(async (_req, res) => {
    try {
      res.json({ models: await listModels() });
    } catch (err) {
      throw new ApiError(502, 'AI_FAILED', errorText(err));
    }
  }),
);

/** POST /api/ai/ask — the operator's own assistant. */
aiRouter.post(
  '/ask',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).min(1).max(40),
        conversationId: z.string().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Type a question.');
    try {
      res.json(await askAssistant(parsed.data.messages, parsed.data.conversationId));
    } catch (err) {
      throw new ApiError(502, 'AI_FAILED', errorText(err));
    }
  }),
);

// ===== Actions =====

const paramSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,40}$/, 'Parameter names: letters, digits, _'),
  description: z.string().max(300).default(''),
  required: z.boolean().default(true),
});

const actionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Name: lowercase letters, digits and _ (e.g. order_status).'),
  title: z.string().trim().min(1).max(80),
  description: z.string().max(1000).default(''),
  kind: z.enum(['http', 'mailerlite']),
  enabled: z.boolean().default(true),
  allowInCustomerChats: z.boolean().default(false),
  config: z.union([
    z.object({ apiKey: z.string().max(2000) }),
    z.object({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      url: z.string().url().max(2000),
      headers: z.record(z.string(), z.string().max(4000)).default({}),
      body: z.string().max(8000).default(''),
      params: z.array(paramSchema).max(15).default([]),
    }),
  ]),
});

aiRouter.get(
  '/actions',
  asyncHandler(async (_req, res) => {
    const rows = await prisma.aiAction.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ actions: rows.map(maskAction) });
  }),
);

/** Keep stored secrets when the browser sends back the mask. */
function mergeSecrets(kind: string, next: Record<string, unknown>, prev: Record<string, unknown> | null) {
  if (!prev) return next;
  if (kind === 'mailerlite' && next.apiKey === SECRET_MASK) next.apiKey = prev.apiKey;
  if (kind === 'http' && next.headers && typeof next.headers === 'object') {
    const ph = (prev.headers ?? {}) as Record<string, string>;
    next.headers = Object.fromEntries(
      Object.entries(next.headers as Record<string, string>).map(([k, v]) => [k, v === SECRET_MASK ? ph[k] ?? '' : v]),
    );
  }
  return next;
}

aiRouter.post(
  '/actions',
  asyncHandler(async (req, res) => {
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', parsed.error.issues[0]?.message ?? 'Invalid action.');
    if (await prisma.aiAction.findUnique({ where: { name: parsed.data.name } })) {
      throw new ApiError(409, 'DUPLICATE', 'An action with this name already exists.');
    }
    const row = await prisma.aiAction.create({ data: { ...parsed.data, config: parsed.data.config as Prisma.InputJsonValue } });
    emitEphemeral('library.changed', null, { kind: 'aiActions' });
    res.status(201).json({ action: maskAction(row) });
  }),
);

aiRouter.put(
  '/actions/:id',
  asyncHandler(async (req, res) => {
    const parsed = actionSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', parsed.error.issues[0]?.message ?? 'Invalid action.');
    const prev = await prisma.aiAction.findUnique({ where: { id: req.params.id! } });
    if (!prev) throw new ApiError(404, 'NOT_FOUND', 'Action not found.');
    const dup = await prisma.aiAction.findFirst({ where: { name: parsed.data.name, id: { not: prev.id } } });
    if (dup) throw new ApiError(409, 'DUPLICATE', 'An action with this name already exists.');
    const config = mergeSecrets(parsed.data.kind, { ...parsed.data.config }, prev.kind === parsed.data.kind ? (prev.config as Record<string, unknown>) : null);
    const row = await prisma.aiAction.update({
      where: { id: prev.id },
      data: { ...parsed.data, config: config as Prisma.InputJsonValue },
    });
    emitEphemeral('library.changed', null, { kind: 'aiActions' });
    res.json({ action: maskAction(row) });
  }),
);

aiRouter.delete(
  '/actions/:id',
  asyncHandler(async (req, res) => {
    await prisma.aiAction.delete({ where: { id: req.params.id! } }).catch(() => undefined);
    emitEphemeral('library.changed', null, { kind: 'aiActions' });
    res.json({ ok: true });
  }),
);

/** POST /api/ai/actions/:id/test — run it now with sample arguments and show the raw result. */
aiRouter.post(
  '/actions/:id/test',
  asyncHandler(async (req, res) => {
    const a = await prisma.aiAction.findUnique({ where: { id: req.params.id! } });
    if (!a) throw new ApiError(404, 'NOT_FOUND', 'Action not found.');
    const fn = typeof req.body?.fn === 'string' ? req.body.fn : undefined;
    const args = req.body?.args && typeof req.body.args === 'object' ? (req.body.args as Record<string, unknown>) : {};
    try {
      const result = await testAction(a, fn, args);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      res.json({ ok: true, result: text.slice(0, 20000) });
    } catch (err) {
      res.json({ ok: false, error: err instanceof Error ? err.message : 'Failed.' });
    }
  }),
);
