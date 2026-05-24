import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError } from '../lib/errors';
import { windowState, WindowClosedError } from '../lib/window';
import { prisma } from '../db/prisma';

export const messagesRouter = Router();

const sendTextSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().min(1).max(4096),
  clientId: z.string().min(1).max(64),
});

/**
 * POST /api/messages
 * Phase 2 ticket 2.4 — send a free-form text message.
 *
 * Behaviour:
 *  1. Validate input.
 *  2. Look up conversation; enforce 24h window (deep-dive §6).
 *  3. UPSERT Message row (status=queued, clientId for optimistic reconciliation).
 *  4. Call TwilioGateway.sendText (this should move to a job for retry resilience).
 *  5. Emit outbox event 'message.added' so the sender's other tabs see it.
 *
 * STUB: window check is wired up; gateway call still to do (Phase 2).
 */
messagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = sendTextSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid send-message payload.');

    const conv = await prisma.conversation.findUnique({
      where: { id: parsed.data.conversationId },
      select: { id: true, twilioConversationSid: true, lastInboundAt: true },
    });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    if (!windowState(conv.lastInboundAt).open) {
      throw new ApiError(409, 'WINDOW_CLOSED', new WindowClosedError().message);
    }

    // TODO Phase 2 ticket 2.4:
    //   const result = await twilioGateway.sendText({
    //     conversationSid: conv.twilioConversationSid,
    //     body: parsed.data.body,
    //     clientId: parsed.data.clientId,
    //   });
    //   await withOutbox(async (tx, emit) => {
    //     const msg = await tx.message.create({ ... });
    //     await emit({ kind: 'message.added', conversationId: conv.id, payload: { messageId: msg.id } });
    //   });
    //   res.json({ messageId: msg.id, twilioSid: result.sid });

    res.status(501).json({ code: 'NOT_IMPLEMENTED', message: 'Implement in Phase 2 ticket 2.4.' });
  }),
);

/**
 * POST /api/messages/voice — Phase 5 ticket 5.2.
 * POST /api/messages/media — Phase 4 ticket 4.2.
 * POST /api/messages/:id/reaction — Phase 5 ticket 5.6.
 */
messagesRouter.post('/voice', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
messagesRouter.post('/media', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
messagesRouter.post('/:id/reaction', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
