import crypto from 'node:crypto';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { twilioClient } from '../twilio/client';
import { saveMedia, signMediaToken, mimeToType } from './mediaStore';
import { compressVideoToFit, SAFE_VIDEO_BYTES, VideoTooLargeError } from './videoTranscode';
import { twilioErrorMessage } from './errors';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Shared "send a file to a WhatsApp chat now" path.
 *
 * Used by the live upload route, forwarding, retry and scheduled media, so all
 * of them store the same Message row, emit the same realtime event and get the
 * same automatic video compression.
 *
 * Callers do the 24h window check first.
 */

export class MediaDeliverError extends Error {
  constructor(
    public code: 'VIDEO_TOO_LARGE' | 'COMPRESSION_FAILED' | 'STORAGE_FAILED' | 'TWILIO_SEND_FAILED',
    message: string,
    public twilioCode?: string,
  ) {
    super(message);
    this.name = 'MediaDeliverError';
  }
}

/**
 * Base URL Twilio fetches outbound media from. Prefer a URL that bypasses any
 * CDN that blocks Twilio's media bot (error 63019).
 */
export function mediaPublicBaseUrl(): string {
  if (env.MEDIA_PUBLIC_BASE_URL) return env.MEDIA_PUBLIC_BASE_URL;
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railway) return `https://${railway}`;
  return env.PUBLIC_BASE_URL;
}

export interface MediaMessageOut {
  id: string;
  clientId: string | null;
  twilioSid: string;
  direction: 'outbound';
  type: string;
  status: string;
  body: string | null;
  mediaUrl: string;
  mediaMime: string | null;
  mediaName: string | null;
  hasMedia: true;
  sentAt: Date;
  origin: string | null;
}

export async function deliverMedia(input: {
  conv: { id: string; contact: { phoneNumber: string } };
  buffer: Buffer;
  mime: string;
  name: string;
  caption?: string | null;
  clientId?: string;
  origin?: string | null;
}): Promise<MediaMessageOut> {
  const { conv } = input;
  let mime = input.mime || 'application/octet-stream';
  let buffer = input.buffer;
  let originalName = input.name;
  const type = mimeToType(mime);
  const caption = input.caption?.trim() || undefined;

  // WhatsApp hard-rejects video > 16MB; compress like the WhatsApp app does.
  if (type === 'video' && buffer.length > SAFE_VIDEO_BYTES) {
    try {
      const out = await compressVideoToFit(buffer, originalName);
      buffer = out.buffer;
      mime = out.mime;
      originalName = out.filename;
    } catch (err) {
      if (err instanceof VideoTooLargeError) {
        throw new MediaDeliverError(
          'VIDEO_TOO_LARGE',
          "This video is too long to compress under WhatsApp's 16 MB limit. Trim it shorter and try again.",
        );
      }
      logger.error({ err, conversationId: conv.id }, 'video compression failed');
      throw new MediaDeliverError('COMPRESSION_FAILED', 'Could not process this video. Try a different file.');
    }
  }

  const draft = await prisma.message.create({
    data: {
      conversationId: conv.id,
      twilioSid: `pending:${crypto.randomUUID()}`,
      clientId: input.clientId ?? `c_${crypto.randomUUID()}`,
      direction: 'outbound',
      type,
      status: 'queued',
      body: caption ?? null,
      mediaMime: mime,
      mediaName: originalName,
      mediaSize: buffer.length,
      mediaUrl: 'local:pending',
      origin: input.origin ?? null,
      sentAt: new Date(),
    },
  });

  try {
    await saveMedia(draft.id, buffer);
  } catch (err) {
    logger.error({ err, id: draft.id }, 'saveMedia failed');
    await prisma.message.update({ where: { id: draft.id }, data: { status: 'failed' } });
    throw new MediaDeliverError('STORAGE_FAILED', 'Could not store the file on the server.');
  }
  await prisma.message.update({ where: { id: draft.id }, data: { mediaUrl: `local:${draft.id}` } });

  const publicUrl = `${mediaPublicBaseUrl()}/public/media/${signMediaToken(draft.id)}`;
  let sid: string;
  try {
    const sent = await twilioClient.messages.create({
      from: env.TWILIO_WHATSAPP_SENDER,
      to: `whatsapp:${conv.contact.phoneNumber}`,
      mediaUrl: [publicUrl],
      body: caption,
      statusCallback: `${env.PUBLIC_BASE_URL}/webhooks/twilio/status`,
    });
    sid = sent.sid;
  } catch (err) {
    const e = err as { code?: string | number; message?: string };
    logger.error({ err, conversationId: conv.id }, 'Twilio media send failed');
    await prisma.message.update({
      where: { id: draft.id },
      data: { status: 'failed', errorCode: e.code ? String(e.code) : null, errorMessage: e.message ?? null },
    });
    const code = e.code ? String(e.code) : undefined;
    const detail = e.code ? ` [Twilio ${e.code}: ${e.message ?? ''}]` : e.message ? ` [${e.message}]` : '';
    throw new MediaDeliverError('TWILIO_SEND_FAILED', `${twilioErrorMessage(code)}${detail}`, code);
  }

  const m = await withOutbox(async (tx, emit) => {
    const row = await tx.message.update({ where: { id: draft.id }, data: { twilioSid: sid, status: 'sent' } });
    await tx.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date() } });
    await emit({
      kind: 'message.added',
      conversationId: conv.id,
      payload: {
        messageId: row.id,
        clientId: row.clientId,
        direction: 'outbound',
        type: row.type,
        status: row.status,
        body: row.body,
        sentAt: row.sentAt,
        hasMedia: true,
        mediaMime: row.mediaMime,
        mediaName: row.mediaName,
        origin: row.origin,
      },
    });
    return row;
  });

  return {
    id: m.id,
    clientId: m.clientId,
    twilioSid: m.twilioSid,
    direction: 'outbound',
    type: m.type,
    status: m.status,
    body: m.body,
    mediaUrl: `/api/media/${m.id}`,
    mediaMime: m.mediaMime,
    mediaName: m.mediaName,
    hasMedia: true,
    sentAt: m.sentAt,
    origin: m.origin,
  };
}
