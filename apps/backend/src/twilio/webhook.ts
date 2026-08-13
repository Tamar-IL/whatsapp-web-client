import { Router, urlencoded } from 'express';
import { logger } from '../config/logger';
import { asyncHandler } from '../lib/asyncHandler';
import { verifyTwilioSignature } from './signature';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { mapTwilioStatus, statusRank, syntheticConversationSid } from './programmable';
import { env } from '../config/env';
import { saveMedia } from '../lib/mediaStore';
import { queueMediaForWebhook } from '../lib/makeWebhook';
import { transcribeAudio } from '../lib/transcribe';
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
      // fullPayload is the audit trail for "did this message reach us at all?".
      // Note it includes message bodies — drop it if log retention ever becomes
      // a privacy concern.
      { messageSid, from, hasBody: Boolean(p.Body), numMedia: p.NumMedia, fullPayload: p },
      'Twilio inbound webhook',
    );

    let followUp: (() => Promise<void>) | null = null;
    try {
      followUp = await handleInbound(p, messageSid, from);
    } catch (err) {
      // CRITICAL: do NOT ack. Twilio only retries inbound webhooks on a non-2xx
      // response, so swallowing this and returning 200 loses the customer's
      // message permanently. The MessageSid idempotency check above makes the
      // retry safe — at worst we redo work we already did.
      logger.error({ err, messageSid }, 'inbound handler failed — returning 500 so Twilio retries');
      res.status(500).type('text/xml').send('<Response></Response>');
      return;
    }

    // Ack FIRST: the message is durably stored by this point. Media download and
    // transcription take far longer than Twilio's ~15s webhook budget, so they
    // must never sit between the write and the ack.
    emptyTwiml(res);

    if (followUp) {
      void followUp().catch((err) =>
        logger.error({ err, messageSid }, 'post-ack inbound media work failed'),
      );
    }
  }),
);

/**
 * Persist an inbound message. Returns an optional follow-up task (media
 * download / transcription / Make forwarding) to be run AFTER the webhook is
 * acked, or null when there is nothing further to do.
 *
 * Throws on any persistence failure so the caller can answer non-2xx and let
 * Twilio redeliver.
 */
async function handleInbound(
  p: Record<string, string>,
  messageSid: string | undefined,
  from: string | undefined,
): Promise<(() => Promise<void>) | null> {
  if (!messageSid || !from) {
    // Nothing to key on or reply to — a retry would fail identically, so ack.
    logger.warn({ messageSid, from }, 'inbound missing MessageSid or From');
    return null;
  }

  // Idempotency: Twilio retries inbound webhooks on non-2xx.
  const existing = await prisma.message.findUnique({
    where: { twilioSid: messageSid },
    select: { id: true },
  });
  if (existing) return null;

  const customerPhone = from.replace(/^whatsapp:/, '');
  const profileName = p.ProfileName || undefined;
  const numMedia = parseInt(p.NumMedia || '0', 10);

  // Media metadata (bytes are fetched after the ack).
  let type: MessageType = 'text';
  let body: string | null = p.Body || null;
  let mediaUrl: string | undefined;
  let mediaMime: string | undefined;

  // A reaction is detected BEFORE the body/media branches below, because Twilio
  // may deliver one with the emoji sitting in `Body` (see detectReaction).
  const reaction = detectReaction(p, numMedia);

  if (reaction) {
    type = 'reaction';
    body = reaction.emoji;
  } else if (numMedia > 0) {
    mediaUrl = p.MediaUrl0; // authenticated Twilio URL — proxy/download later
    mediaMime = p.MediaContentType0;
    if (mediaMime?.startsWith('image/')) type = 'image';
    else if (mediaMime?.startsWith('video/')) type = 'video';
    else if (mediaMime?.startsWith('audio/')) type = 'audio';
    else type = 'document';
  } else if (!body) {
    // No text and no media: a location, an interactive reply, or a type we don't
    // model yet. These used to be dropped on the floor, which made real customer
    // messages silently vanish. Always store SOMETHING so the operator can see
    // that a message arrived.
    const decoded = decodeBodylessInbound(p);
    type = decoded.type;
    body = decoded.body;
  }

  const convSid = syntheticConversationSid(customerPhone);
  const now = new Date();

  const created = await withOutbox(async (tx, emit) => {
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
    // A reaction reuses that same field to name its target, so it is consumed as
    // `reactsToId` below instead — a reaction must not render a quote block.
    const replyToSid = reaction ? null : p.OriginalRepliedMessageSid || null;
    let replyTo: { id: string; body: string | null; direction: string; type: string } | null = null;
    if (replyToSid) {
      const quoted = await tx.message.findUnique({
        where: { twilioSid: replyToSid },
        select: { id: true, body: true, direction: true, type: true },
      });
      if (quoted) {
        replyTo = { id: quoted.id, body: quoted.body, direction: quoted.direction, type: quoted.type };
      }
    }

    // Resolve which stored message a reaction points at. An unresolvable target
    // (reacted to something older than our history) still gets stored, and the
    // UI shows it as a standalone bubble rather than hiding it.
    let reactsToId: string | null = null;
    if (reaction?.targetSid) {
      const target = await tx.message.findUnique({
        where: { twilioSid: reaction.targetSid },
        select: { id: true },
      });
      reactsToId = target?.id ?? null;
      if (!target) {
        logger.warn(
          { messageSid, targetSid: reaction.targetSid },
          'reaction target not found in our history — storing unattached',
        );
      }
    }

    const message = await tx.message.create({
      data: {
        conversationId: conv.id,
        twilioSid: messageSid,
        direction: 'inbound',
        type,
        status: 'received',
        body,
        mediaUrl: mediaUrl ?? null,
        mediaMime: mediaMime ?? null,
        replyToTwilioSid: replyToSid,
        reactsToId,
        sentAt: now,
      },
    });

    // Reactions are not unread "messages" — they would inflate the badge and, for
    // a removal, announce that nothing happened. They still bump lastMessageAt so
    // the thread surfaces in the list.
    await tx.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: now,
        lastInboundAt: now,
        ...(reaction ? {} : { unreadCount: { increment: 1 } }),
      },
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
        // Lets the client attach the emoji to the target bubble live.
        reactsToId,
      },
    });

    return message;
  });

  // Pull the actual bytes off Twilio promptly, while the media definitely still
  // exists, and store our own copy. Inbound Twilio media URLs expire (and need
  // Basic auth), which is what made old recordings show "Media unavailable".
  // Once stored, /api/media/:id serves our local copy instead of re-fetching.
  //
  // Returned rather than awaited: the caller runs this AFTER acking Twilio. A
  // 20s download plus a 30s transcription blows straight through Twilio's ~15s
  // webhook budget, which used to make every voice note log an 11200 error.
  if (mediaUrl && created?.id) {
    const mediaId = created.id;
    const url = mediaUrl;
    return () =>
      persistInboundMedia(mediaId, url, mediaMime, {
        phone: customerPhone,
        senderName: profileName ?? customerPhone,
        sentAt: now,
        type,
      });
  }

  return null;
}

/**
 * Work out what a no-text, no-media inbound actually was.
 *
 * WhatsApp sends several message kinds that carry no Body and no media:
 * shared locations, button/list replies, and reactions. Twilio surfaces each
 * with its own set of form fields. We map the ones we recognise onto a real
 * message type and synthesise a readable body; anything unrecognised is stored
 * as a `system` note rather than being discarded, so a message never silently
 * disappears from the operator's view.
 */
function decodeBodylessInbound(p: Record<string, string>): { type: MessageType; body: string } {
  // Shared location.
  if (p.Latitude && p.Longitude) {
    const label = [p.Label, p.Address].filter(Boolean).join(' — ');
    const maps = `https://maps.google.com/?q=${p.Latitude},${p.Longitude}`;
    return { type: 'location', body: label ? `📍 ${label}\n${maps}` : `📍 ${maps}` };
  }

  // Interactive reply (quick-reply button or list selection).
  const buttonText = p.ButtonText || p.ListTitle || p.ListId || p.ButtonPayload;
  if (buttonText) return { type: 'text', body: buttonText };

  logger.warn({ fullPayload: p }, 'inbound with no body/media and no recognised fields — stored as system note');
  return { type: 'system', body: '[unsupported message type — check the WhatsApp app]' };
}

/**
 * Decide whether an inbound webhook is a WhatsApp reaction, and if so which
 * emoji it carries and which message it targets.
 *
 * Twilio does NOT document inbound reaction parameters anywhere, so we do not
 * know whether reactions are forwarded to this webhook at all — they may simply
 * be dropped upstream. This therefore only fires on an UNAMBIGUOUS signal: a
 * dedicated reaction field, or a declared type of "reaction".
 *
 * It deliberately does NOT guess from an emoji-only `Body` carrying reply
 * context. That shape is indistinguishable from a customer genuinely replying
 * with just "👍", and guessing would demote a real message into a badge on
 * another bubble. Mangling real messages is far worse than missing a reaction
 * for a feature Twilio may not even deliver.
 *
 * An empty emoji means the customer REMOVED their reaction — stored as a
 * reaction row with an empty body, which the UI treats as "no longer reacted".
 * Reactions are never deduplicated or deleted: the newest row per target wins at
 * render time, so replacing an emoji works and the history stays auditable.
 *
 * To find out what Twilio actually sends: react to a message from the phone and
 * read the `fullPayload` logged by the inbound handler above.
 *
 * Returns null when this is not a reaction.
 */
function detectReaction(
  p: Record<string, string>,
  numMedia: number,
): { emoji: string; targetSid: string | null } | null {
  if (numMedia > 0) return null; // reactions never carry media

  const targetSid =
    p.ReactionMessageSid || p.OriginalRepliedMessageSid || p.ReactsToMessageSid || null;

  // Explicit signals only — see the note above on why nothing is inferred.
  const explicitEmoji = p.Reaction ?? p.ReactionEmoji ?? p.MessageReaction;
  const declaredType = (p.MessageType || p.EventType || '').toLowerCase();
  if (explicitEmoji !== undefined || declaredType === 'reaction') {
    const emoji = (explicitEmoji ?? p.Body ?? '').trim();
    logger.info({ emoji, targetSid, via: 'explicit-field' }, 'inbound reaction');
    return { emoji, targetSid };
  }

  return null;
}

/**
 * Download an inbound Twilio media file and store it on disk, then flip the
 * message's mediaUrl to "local:<id>" so it's served from our own copy. Best
 * effort: on any failure we leave the original Twilio URL in place so the
 * on-demand proxy in api/media.ts can still try to fetch it later.
 */
interface InboundMeta {
  phone: string;
  senderName: string;
  sentAt: Date;
  type: MessageType;
}

async function persistInboundMedia(
  messageId: string,
  twilioUrl: string,
  mime: string | undefined,
  meta: InboundMeta,
): Promise<void> {
  try {
    const authHeader =
      'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const upstream = await fetch(twilioUrl, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok) {
      logger.warn({ messageId, status: upstream.status }, 'inbound media persist: upstream non-OK');
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    await saveMedia(messageId, buf);
    // IMPORTANT: keep the original Twilio URL in mediaUrl as a fallback source.
    // media.ts serves our stored copy when present and re-fetches from Twilio if
    // the copy was wiped (Railway's disk is ephemeral). Overwriting it with
    // "local:<id>" would strand the media after a restart. Only refresh the MIME
    // if Twilio reported a better one than we recorded.
    const resolvedMime = mime || upstream.headers.get('content-type') || undefined;
    if (resolvedMime && resolvedMime !== mime) {
      await prisma.message.update({ where: { id: messageId }, data: { mediaMime: resolvedMime } });
    }
    logger.info({ messageId, bytes: buf.length }, 'inbound media cached locally (Twilio URL kept as fallback)');

    // Transcribe audio and update the message body so it shows in the chat.
    if (meta.type === 'audio') {
      const transcript = await transcribeAudio(buf, resolvedMime ?? 'audio/ogg');
      if (transcript) {
        const msg = await prisma.message.findUnique({
          where: { id: messageId },
          select: { conversationId: true },
        });
        if (msg) {
          await withOutbox(async (tx, emit) => {
            await tx.message.update({ where: { id: messageId }, data: { body: transcript } });
            await emit({
              kind: 'message.updated',
              conversationId: msg.conversationId,
              payload: { messageId, body: transcript },
            });
          });
        }
      }
    }

    // Forward to Make.com (debounced — batches bursts from the same contact).
    queueMediaForWebhook({
      phone: meta.phone,
      senderName: meta.senderName,
      sentAt: meta.sentAt,
      type: meta.type,
      mime: resolvedMime ?? 'application/octet-stream',
      name: null,
      buf,
    });
  } catch (err) {
    logger.error({ err, messageId }, 'inbound media persist failed (kept Twilio URL)');
  }
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
