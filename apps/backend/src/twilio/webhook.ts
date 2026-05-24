import { Router, urlencoded } from 'express';
import { logger } from '../config/logger';
import { asyncHandler } from '../lib/asyncHandler';
import { verifyTwilioSignature } from './signature';
import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { env } from '../config/env';
import type {
  MessageDirection,
  MessageStatus,
  MessageType,
} from '@prisma/client';

/**
 * Twilio Conversations webhook handler — Phase 2 tickets 2.3, 2.5.
 *
 * Handles:
 *  - onConversationAdded: logged only; conversation rows are created lazily
 *    in onMessageAdded so we have the customer's phone number.
 *  - onMessageAdded: upsert Contact (if new) + Conversation (if new) + Message;
 *    update conversation counters; emit realtime events.
 *  - onMessageUpdated / onDeliveryUpdated: monotonic status update (stubbed).
 *
 * Idempotency: every message is keyed by Twilio's MessageSid (unique constraint).
 * Twilio retries are safe — we early-return on duplicate.
 */

export const twilioWebhookRouter = Router();

twilioWebhookRouter.use(urlencoded({ extended: false, limit: '1mb' }));
twilioWebhookRouter.use(verifyTwilioSignature);

interface ConversationsPayload {
  EventType: string;
  ConversationSid?: string;
  MessageSid?: string;
  Author?: string;
  Body?: string;
  Media?: string; // JSON array string when media is attached
  DateCreated?: string;
  Attributes?: string; // JSON string
  Index?: string;
  ParticipantSid?: string;
}

twilioWebhookRouter.post(
  '/conversations',
  asyncHandler(async (req, res) => {
    const payload = req.body as ConversationsPayload;

    logger.info(
      {
        eventType: payload.EventType,
        conversationSid: payload.ConversationSid,
        messageSid: payload.MessageSid,
        author: payload.Author,
      },
      'Twilio webhook',
    );

    try {
      switch (payload.EventType) {
        case 'onConversationAdded':
          await handleConversationAdded(payload);
          break;
        case 'onMessageAdded':
          await handleMessageAdded(payload);
          break;
        case 'onMessageUpdated':
        case 'onDeliveryUpdated':
          await handleStatusUpdate(payload);
          break;
        default:
          // Unknown event type — log and ack to prevent retries.
          break;
      }
    } catch (err) {
      // Log loudly but still ack — application bugs shouldn't cause Twilio retries.
      // In production, route this to a dead-letter queue.
      logger.error({ err, payload }, 'Webhook handler error');
    }

    res.status(200).send('ok');
  }),
);

twilioWebhookRouter.post(
  '/status',
  asyncHandler(async (req, res) => {
    // Legacy Programmable Messaging status callbacks land here.
    // With Conversations API, status comes via onDeliveryUpdated on /conversations.
    logger.info({ body: req.body }, 'Twilio status callback (legacy)');
    res.status(200).send('ok');
  }),
);

// ===== Handlers =====

async function handleConversationAdded(payload: ConversationsPayload): Promise<void> {
  logger.info({ conversationSid: payload.ConversationSid }, 'onConversationAdded (will create lazily on first message)');
}

async function handleMessageAdded(payload: ConversationsPayload): Promise<void> {
  const { ConversationSid, MessageSid, Author, Body, Media, DateCreated, Attributes } = payload;

  if (!ConversationSid || !MessageSid || !Author || !DateCreated) {
    logger.warn({ payload }, 'onMessageAdded missing required fields');
    return;
  }

  // Idempotency — skip if we've already stored this Twilio message.
  const existing = await prisma.message.findUnique({
    where: { twilioSid: MessageSid },
    select: { id: true },
  });
  if (existing) {
    logger.debug({ messageSid: MessageSid }, 'Duplicate webhook — message already stored');
    return;
  }

  const isOutbound = Author === env.TWILIO_WHATSAPP_SENDER;
  const direction: MessageDirection = isOutbound ? 'outbound' : 'inbound';

  // Recover the optimistic clientId we set when sending (for outbound echoes).
  let clientId: string | undefined;
  if (Attributes) {
    try {
      const attrs = JSON.parse(Attributes) as { clientId?: string };
      clientId = attrs.clientId;
    } catch {
      // ignore malformed attributes
    }
  }

  // Determine message type from attached media (if any).
  let type: MessageType = 'text';
  let mediaMime: string | undefined;
  let mediaName: string | undefined;
  let mediaSize: number | undefined;
  if (Media) {
    try {
      const media = JSON.parse(Media) as Array<{
        Sid?: string;
        ContentType?: string;
        Filename?: string;
        Size?: number;
      }>;
      const first = media[0];
      if (first) {
        mediaMime = first.ContentType;
        mediaName = first.Filename;
        mediaSize = first.Size;
        if (mediaMime?.startsWith('image/')) type = 'image';
        else if (mediaMime?.startsWith('video/')) type = 'video';
        else if (mediaMime?.startsWith('audio/')) type = 'audio';
        else type = 'document';
      }
    } catch {
      // ignore malformed media
    }
  }

  const status: MessageStatus = isOutbound ? 'sent' : 'received';
  const sentAt = new Date(DateCreated);

  await withOutbox(async (tx, emit) => {
    // Lazy upsert of Contact + Conversation on first inbound from a new number.
    let conv = await tx.conversation.findUnique({
      where: { twilioConversationSid: ConversationSid },
      select: { id: true, contactId: true },
    });

    if (!conv) {
      if (isOutbound) {
        // Outbound for a conversation we don't know about — unexpected for v1.
        logger.warn({ ConversationSid, Author }, 'Outbound message for unknown conversation; skipping');
        return;
      }

      // Author looks like "whatsapp:+15551234567"
      const customerPhone = Author.replace(/^whatsapp:/, '');

      const contact = await tx.contact.upsert({
        where: { phoneNumber: customerPhone },
        create: { phoneNumber: customerPhone },
        update: {},
      });

      const newConv = await tx.conversation.create({
        data: {
          contactId: contact.id,
          twilioConversationSid: ConversationSid,
          lastMessageAt: sentAt,
          lastInboundAt: sentAt,
          unreadCount: 0, // incremented below when we save the message
        },
      });
      conv = { id: newConv.id, contactId: contact.id };

      await emit({
        kind: 'conversation.added',
        conversationId: newConv.id,
        payload: {
          conversationId: newConv.id,
          contact: {
            id: contact.id,
            phoneNumber: contact.phoneNumber,
            displayName: contact.displayName,
            profileName: contact.profileName,
          },
        },
      });
    }

    const message = await tx.message.create({
      data: {
        conversationId: conv.id,
        twilioSid: MessageSid,
        clientId,
        direction,
        type,
        status,
        body: Body ?? null,
        mediaMime: mediaMime ?? null,
        mediaName: mediaName ?? null,
        mediaSize: mediaSize ?? null,
        sentAt,
      },
    });

    await tx.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: sentAt,
        ...(isOutbound
          ? {}
          : {
              lastInboundAt: sentAt,
              unreadCount: { increment: 1 },
            }),
      },
    });

    await emit({
      kind: 'message.added',
      conversationId: conv.id,
      payload: {
        messageId: message.id,
        twilioSid: message.twilioSid,
        clientId: message.clientId,
        direction: message.direction,
        type: message.type,
        status: message.status,
        body: message.body,
        sentAt: message.sentAt,
      },
    });
  });
}

async function handleStatusUpdate(payload: ConversationsPayload): Promise<void> {
  // TODO Phase 2 ticket 2.5: monotonic status update.
  // Conversations API doesn't surface "delivered"/"read" the same way as
  // Programmable Messaging — the relevant fields appear in onDeliveryUpdated.
  // For now: log only.
  logger.info({ messageSid: payload.MessageSid, eventType: payload.EventType }, 'Status update (stub)');
}
