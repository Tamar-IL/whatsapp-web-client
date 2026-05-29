import { Router, urlencoded } from 'express';
import { logger } from '../config/logger';
import { asyncHandler } from '../lib/asyncHandler';
import { verifyTwilioSignature } from './signature';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { mapTwilioStatus, statusRank, syntheticConversationSid } from './programmable';
import type { MessageType } from '@prisma/client';

/**
 * Twilio Programmable Messaging webhooks (the spec's §3.6 path).
 *
 *  - POST /webhooks/twilio/inbound : incoming WhatsApp messages from customers.
 *  - POST /webhooks/twilio/status  : delivery/read status callbacks for outbound.
 *
 * Both verify the Twilio signature, ack fast (<1s), and reply with empty TwiML
 * (`<Response></Response>`) which is what Twilio expects for messaging webhooks.
 *
 * Idempotency: messages are keyed by Twilio's MessageSid (unique constraint).
 * A conversation is identified by the customer's phone (one per contact); we
 * store "pm:<phone>" as the synthetic conversation SID.
 */

export const twilioWebhookRouter = Router();

twilioWebhookRouter.use(urlencoded({ extended: false, limit: '2mb' }));
twilioWebhookRouter.use(verifyTwilioSignature);

const emptyTwiml = (res: import('express').Response) =>
  res.type('text/xml').send('<Response></Response>');

// ===== Inbound messages =====

twilioWebhookRouter.post(
  '/inbound',
  asyncHandler(async (req, res) => {
    const p = req.body as Record<string, string>;
    const messageSid = p.MessageSid || p.SmsSid || p.SmsMessageSid;
    const from = p.From; // "whatsapp:+15551234567"

    logger.info(
      // SPIKE: fullPayload lets us inspect for reaction/quoted-reply context
      // fields. Remove once reactions/replies support is decided.
      { messageSid, from, hasBody: Boolean(p.Body), numMedia: p.NumMedia, fullPayload: p },
      'Twilio inbound webhook',
    );

    try {
      await handleInbound(p, messageSid, from);
    } catch (err) {
      logger.error({ err, messageSid }, 'inbound handler error');
    }

    emptyTwiml(res);
  }),
);

async function handleInbound(
  p: Record<string, string>,
  messageSid: string | undefined,
  from: string | undefined,
): Promise<void> {
  if (!messageSid || !from) {
    logger.warn({ messageSid, from }, 'inbound missing MessageSid or From');
    return;
  }

  // Idempotency: Twilio retries inbound webhooks on non-2xx.
  const existing = await prisma.message.findUnique({
    where: { twilioSid: messageSid },
    select: { id: true },
  });
  if (existing) return;

  const customerPhone = from.replace(/^whatsapp:/, '');
  const profileName = p.ProfileName || undefined;
  const numMedia = parseInt(p.NumMedia || '0', 10);

  // SPIKE (reactions): WhatsApp reactions and other special inbound types arrive
  // with no Body and no media. Log the full payload so we can see Twilio's exact
  // format, and DON'T create an empty bubble. Once we know the shape from logs,
  // we'll implement reaction storage/display.
  if (!p.Body && numMedia === 0) {
    logger.info({ fullPayload: p }, 'Inbound non-text message (candidate reaction/system) — capturing format');
    return;
  }

  // Media metadata (full download happens in Phase 4 via the job queue).
  let type: MessageType = 'text';
  let mediaUrl: string | undefined;
  let mediaMime: string | undefined;
  if (numMedia > 0) {
    mediaUrl = p.MediaUrl0; // authenticated Twilio URL — proxy/download later
    mediaMime = p.MediaContentType0;
    if (mediaMime?.startsWith('image/')) type = 'image';
    else if (mediaMime?.startsWith('video/')) type = 'video';
    else if (mediaMime?.startsWith('audio/')) type = 'audio';
    else type = 'document';
  }

  const convSid = syntheticConversationSid(customerPhone);
  const now = new Date();

  await withOutbox(async (tx, emit) => {
    const contact = await tx.contact.upsert({
      where: { phoneNumber: customerPhone },
      create: { phoneNumber: customerPhone, profileName },
      update: profileName ? { profileName } : {},
    });

    let conv = await tx.conversation.findUnique({
      where: { twilioConversationSid: convSid },
      select: { id: true },
    });

    if (!conv) {
      const created = await tx.conversation.create({
        data: {
          contactId: contact.id,
          twilioConversationSid: convSid,
          lastMessageAt: now,
          lastInboundAt: now,
          unreadCount: 0,
        },
        select: { id: true },
      });
      conv = created;
      await emit({
        kind: 'conversation.added',
        conversationId: created.id,
        payload: {
          conversationId: created.id,
          contact: {
            id: contact.id,
            phoneNumber: contact.phoneNumber,
            displayName: contact.displayName,
            profileName: contact.profileName,
          },
        },
      });
    }

    // Quoted reply: WhatsApp sends OriginalRepliedMessageSid when the customer
    // replies to a specific message. Store the ref + resolve a snippet to show.
    const replyToSid = p.OriginalRepliedMessageSid || null;
    let replyTo: { body: string | null; direction: string; type: string } | null = null;
    if (replyToSid) {
      const quoted = await tx.message.findUnique({
        where: { twilioSid: replyToSid },
        select: { body: true, direction: true, type: true },
      });
      if (quoted) replyTo = { body: quoted.body, direction: quoted.direction, type: quoted.type };
    }

    const message = await tx.message.create({
      data: {
        conversationId: conv.id,
        twilioSid: messageSid,
        direction: 'inbound',
        type,
        status: 'received',
        body: p.Body || null,
        mediaUrl: mediaUrl ?? null,
        mediaMime: mediaMime ?? null,
        replyToTwilioSid: replyToSid,
        sentAt: now,
      },
    });

    await tx.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: now, lastInboundAt: now, unreadCount: { increment: 1 } },
    });

    await emit({
      kind: 'message.added',
      conversationId: conv.id,
      payload: {
        messageId: message.id,
        direction: 'inbound',
        type: message.type,
        status: message.status,
        body: message.body,
        sentAt: message.sentAt,
        // Include media metadata so the client renders inline without a reload.
        hasMedia: Boolean(message.mediaUrl),
        mediaMime: message.mediaMime,
        mediaName: message.mediaName,
        replyTo,
      },
    });
  });
}

// ===== Status callbacks (outbound delivery/read) =====

twilioWebhookRouter.post(
  '/status',
  asyncHandler(async (req, res) => {
    const p = req.body as Record<string, string>;
    const sid = p.MessageSid || p.SmsSid || p.SmsMessageSid;
    const newStatus = mapTwilioStatus(p.MessageStatus);

    logger.info(
      { messageSid: sid, twilioStatus: p.MessageStatus, errorCode: p.ErrorCode },
      'Twilio status callback',
    );

    try {
      if (sid && newStatus) await applyStatus(sid, newStatus, p.ErrorCode);
    } catch (err) {
      logger.error({ err, sid }, 'status handler error');
    }

    emptyTwiml(res);
  }),
);

async function applyStatus(
  twilioSid: string,
  newStatus: import('@prisma/client').MessageStatus,
  errorCode: string | undefined,
): Promise<void> {
  const msg = await prisma.message.findUnique({
    where: { twilioSid },
    select: { id: true, status: true, conversationId: true },
  });
  if (!msg) return;

  // Monotonic: never downgrade (e.g. don't move read -> delivered).
  if (statusRank(newStatus) < statusRank(msg.status) && newStatus !== 'failed') return;

  await withOutbox(async (tx, emit) => {
    await tx.message.update({
      where: { id: msg.id },
      data: {
        status: newStatus,
        errorCode: errorCode ?? null,
      },
    });
    await emit({
      kind: 'message.updated',
      conversationId: msg.conversationId,
      payload: { messageId: msg.id, status: newStatus, errorCode: errorCode ?? null },
    });
  });
}
