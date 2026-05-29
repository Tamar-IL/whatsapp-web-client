import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError, twilioErrorMessage } from '../lib/errors';
import { windowState, WindowClosedError } from '../lib/window';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { sendWhatsAppText } from '../twilio/programmable';
import { twilioClient } from '../twilio/client';
import { saveMedia, signMediaToken, mimeToType } from '../lib/mediaStore';
import { env } from '../config/env';
import { logger } from '../config/logger';

export const messagesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MEDIA_MAX_BYTES },
});

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
 * POST /api/messages/media — send an image / video / document / audio file.
 *
 * Programmable Messaging sends media by URL, so we:
 *  1. Validate + persist the upload to local disk.
 *  2. Mint a short-lived signed public URL (/public/media/:token).
 *  3. Tell Twilio to fetch that URL and send it to the customer.
 *  4. Store the outbound message (served back to our UI from disk).
 */
messagesRouter.post(
  '/media',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const conversationId = req.body?.conversationId as string | undefined;
    const clientId = (req.body?.clientId as string | undefined) ?? crypto.randomUUID();
    const caption = (req.body?.caption as string | undefined)?.trim() || undefined;
    const file = req.file;

    if (!file || !conversationId) {
      throw new ApiError(400, 'BAD_INPUT', 'A file and conversationId are required.');
    }

    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');
    if (!windowState(conv.lastInboundAt).open) {
      throw new ApiError(409, 'WINDOW_CLOSED', new WindowClosedError().message);
    }

    const mime = file.mimetype || 'application/octet-stream';
    const type = mimeToType(mime);

    // Create the row first so we have an id to key the on-disk file by.
    const draft = await prisma.message.create({
      data: {
        conversationId: conv.id,
        twilioSid: `pending:${crypto.randomUUID()}`,
        clientId,
        direction: 'outbound',
        type,
        status: 'queued',
        body: caption ?? null,
        mediaMime: mime,
        mediaName: file.originalname,
        mediaSize: file.size,
        mediaUrl: 'local:pending',
        sentAt: new Date(),
      },
    });

    try {
      await saveMedia(draft.id, file.buffer);
    } catch (err) {
      logger.error({ err, id: draft.id }, 'saveMedia failed');
      await prisma.message.update({ where: { id: draft.id }, data: { status: 'failed' } });
      throw new ApiError(500, 'STORAGE_FAILED', 'Could not store the file on the server.');
    }
    await prisma.message.update({ where: { id: draft.id }, data: { mediaUrl: `local:${draft.id}` } });

    const publicUrl = `${env.PUBLIC_BASE_URL}/public/media/${signMediaToken(draft.id)}`;
    const statusCallbackUrl = `${env.PUBLIC_BASE_URL}/webhooks/twilio/status`;

    let sid: string;
    try {
      const sent = await twilioClient.messages.create({
        from: env.TWILIO_WHATSAPP_SENDER,
        to: `whatsapp:${conv.contact.phoneNumber}`,
        mediaUrl: [publicUrl],
        body: caption,
        statusCallback: statusCallbackUrl,
      });
      sid = sent.sid;
    } catch (err) {
      const e = err as { code?: string | number; message?: string; status?: number };
      logger.error({ err, conversationId: conv.id, publicUrl }, 'Twilio media send failed');
      await prisma.message.update({
        where: { id: draft.id },
        data: { status: 'failed', errorCode: e.code ? String(e.code) : null, errorMessage: e.message ?? null },
      });
      // Surface the real reason so we can diagnose (Twilio code + message).
      const friendly = twilioErrorMessage(e.code ? String(e.code) : undefined);
      const detail = e.code ? ` [Twilio ${e.code}: ${e.message ?? ''}]` : e.message ? ` [${e.message}]` : '';
      throw new ApiError(502, 'TWILIO_SEND_FAILED', `${friendly}${detail}`);
    }

    const message = await withOutbox(async (tx, emit) => {
      const m = await tx.message.update({
        where: { id: draft.id },
        data: { twilioSid: sid, status: 'sent' },
      });
      await tx.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date() } });
      await emit({
        kind: 'message.added',
        conversationId: conv.id,
        payload: {
          messageId: m.id,
          clientId: m.clientId,
          direction: 'outbound',
          type: m.type,
          status: m.status,
          body: m.body,
          sentAt: m.sentAt,
          hasMedia: true,
          mediaMime: m.mediaMime,
          mediaName: m.mediaName,
        },
      });
      return m;
    });

    res.json({
      message: {
        id: message.id,
        clientId: message.clientId,
        twilioSid: message.twilioSid,
        direction: 'outbound',
        type: message.type,
        status: message.status,
        body: message.body,
        mediaUrl: `/api/media/${message.id}`,
        mediaMime: message.mediaMime,
        mediaName: message.mediaName,
        hasMedia: true,
        sentAt: message.sentAt,
      },
    });
  }),
);

/** POST /api/messages/voice — Phase 5. POST /api/messages/:id/reaction — Phase 5. */
messagesRouter.post('/voice', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
messagesRouter.post('/:id/reaction', (_req, res) => res.status(501).json({ code: 'NOT_IMPLEMENTED' }));
