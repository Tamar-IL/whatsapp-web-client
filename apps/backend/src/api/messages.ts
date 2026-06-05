import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { ApiError, twilioErrorMessage } from '../lib/errors';
import { windowState, WindowClosedError } from '../lib/window';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { deliverText, DeliverError } from '../lib/deliverText';
import { twilioClient } from '../twilio/client';
import { saveMedia, signMediaToken, mimeToType } from '../lib/mediaStore';
import { compressVideoToFit, SAFE_VIDEO_BYTES, VideoTooLargeError } from '../lib/videoTranscode';
import { env } from '../config/env';
import { logger } from '../config/logger';

export const messagesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MEDIA_MAX_BYTES },
});

/**
 * Base URL Twilio fetches outbound media from. We prefer a URL that bypasses
 * Cloudflare (which blocks Twilio's media bot -> error 63019):
 *   1. MEDIA_PUBLIC_BASE_URL if explicitly set
 *   2. the raw Railway domain (RAILWAY_PUBLIC_DOMAIN) — not proxied by Cloudflare
 *   3. PUBLIC_BASE_URL as a last resort
 */
function mediaPublicBaseUrl(): string {
  if (env.MEDIA_PUBLIC_BASE_URL) return env.MEDIA_PUBLIC_BASE_URL;
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railway) return `https://${railway}`;
  return env.PUBLIC_BASE_URL;
}

const sendTextSchema = z.object({
  conversationId: z.string().min(1),
  body: z.string().min(1).max(4096),
  clientId: z.string().min(1).max(64),
  replyToId: z.string().optional(), // id of the message being replied to (quoted)
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

    let delivered;
    try {
      delivered = await deliverText({
        conv,
        body: parsed.data.body,
        clientId: parsed.data.clientId,
        replyToId: parsed.data.replyToId,
        userId: req.session.userId ?? null,
      });
    } catch (err) {
      if (err instanceof DeliverError) {
        throw new ApiError(502, 'TWILIO_SEND_FAILED', twilioErrorMessage(err.twilioCode));
      }
      throw err;
    }

    res.json({ message: delivered.message });
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

    let mime = file.mimetype || 'application/octet-stream';
    let buffer = file.buffer;
    let originalName = file.originalname;
    let mediaSize = file.size;
    const type = mimeToType(mime);

    // WhatsApp hard-rejects video > 16MB (Twilio error 11751). Auto-compress
    // oversized video down to fit — just like the official WhatsApp app does —
    // so the operator can send any clip without worrying about size.
    if (type === 'video' && mediaSize > SAFE_VIDEO_BYTES) {
      logger.info({ conversationId: conv.id, originalBytes: mediaSize }, 'compressing oversized video');
      try {
        const out = await compressVideoToFit(buffer, originalName);
        buffer = out.buffer;
        mime = out.mime;
        originalName = out.filename;
        mediaSize = out.buffer.length;
        logger.info(
          { conversationId: conv.id, originalBytes: file.size, compressedBytes: mediaSize },
          'video compressed',
        );
      } catch (err) {
        if (err instanceof VideoTooLargeError) {
          throw new ApiError(
            413,
            'VIDEO_TOO_LARGE',
            'This video is too long to compress under WhatsApp\'s 16 MB limit. Trim it shorter and try again.',
          );
        }
        logger.error({ err, conversationId: conv.id }, 'video compression failed');
        throw new ApiError(500, 'COMPRESSION_FAILED', 'Could not process this video. Try a different file.');
      }
    }

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
        mediaName: originalName,
        mediaSize,
        mediaUrl: 'local:pending',
        sentAt: new Date(),
      },
    });

    try {
      await saveMedia(draft.id, buffer);
    } catch (err) {
      logger.error({ err, id: draft.id }, 'saveMedia failed');
      await prisma.message.update({ where: { id: draft.id }, data: { status: 'failed' } });
      throw new ApiError(500, 'STORAGE_FAILED', 'Could not store the file on the server.');
    }
    await prisma.message.update({ where: { id: draft.id }, data: { mediaUrl: `local:${draft.id}` } });

    const publicUrl = `${mediaPublicBaseUrl()}/public/media/${signMediaToken(draft.id)}`;
    const statusCallbackUrl = `${env.PUBLIC_BASE_URL}/webhooks/twilio/status`;
    logger.info({ publicUrl, conversationId: conv.id }, 'Sending media via Twilio');

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
