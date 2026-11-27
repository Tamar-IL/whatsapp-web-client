import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { getSettings } from '../lib/settings';
import { blockedReason, decide, errorText, testConnection } from '../lib/aiAgent';

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
