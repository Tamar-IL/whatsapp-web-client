import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError, twilioErrorMessage } from '../lib/errors';
import { windowState, WindowClosedError } from '../lib/window';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { sendWhatsAppText } from '../twilio/programmable';
import { env } from '../config/env';
import { logger } from '../config/logger';

export const messagesRouter = Router();

const sendTextSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().min(1).max(4096),
  clientId: z.string().min(1).max(64),
});

/**
 * POST /api/messages — send a free-form WhatsApp text reply (Programmable Messaging).
 *
 * 1. Validate input.
 * 2. Look up conversation + contact; enforce the 24h window.
 * 3. Send via Twilio; store the message (status=sent) with a status callback.
 * 4. Emit a realtime 'message.added' so all tabs update.
 */
messagesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = sendTextSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid send-message payload.');

    const conv = await prisma.conversation.findUnique({
      where: { id: parsed.data.conversationId },
      include: { contact: true },
    });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    if (!windowState(conv.lastInboundAt).open) {
      throw new ApiError(409, 'WINDOW_CLOSED', new WindowClosedError().message);
    }

    const statusCallbackUrl = `${env.PUBLIC_BASE_URL}/webhooks/twilio/status`;

    let result: { sid: string };
    try {
      result = await sendWhatsAppText({
        toPhone: conv.contact.phoneNumber,
        body: parsed.data.body,
        statusCallbackUrl,
      });
    } catch (err) {
      const code = (err as { code?: string | number })?.code;
      logger.error({ err, conversationId: conv.id }, 'Twilio send failed');
      throw new ApiError(502, 'TWILIO_SEND_FAILED', twilioErrorMessage(code ? String(code) : undefined));
    }

    const now = new Date();
    const message = await withOutbox(async (tx, emit) => {
      const m = await tx.message.create({
        data: {
          conversationId: conv.id,
          twilioSid: result.sid,
          clientId: parsed.data.clientId,
          direction: 'outbound',
          type: 'text',
          status: 'sent',
          body: parsed.data.body,
          sentAt: now,
        },
      });
      await tx.conversation.update({
        where: { id: conv.id },
        data: { lastMessageAt: now },
      });
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
      data: { userId: req.session.userId ?? null, kind: 'message.sent', payload: { conversationId: conv.id } },
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

/**
 * POST /api/messages/voice — Phase 5 ticket 5.2.
 * POST /api/messages/media — Phase 4 ticket 4.2.
 * POST /api/messages/:id/reaction — Phase 5 ticket 5.6.
 */
messagesRouter.post('/voice', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
messagesRouter.post('/media', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
messagesRouter.post('/:id/reaction', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
