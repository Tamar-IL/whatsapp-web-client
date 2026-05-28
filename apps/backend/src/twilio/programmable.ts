import { twilioClient } from './client';
import { env } from '../config/env';
import type { MessageStatus } from '@prisma/client';

/**
 * Programmable Messaging integration (the spec's §3.6 fallback).
 *
 * Used because "Autocreate a Conversation" is disabled on this Twilio account,
 * so the Conversations API path isn't available. Programmable Messaging is
 * simpler for WhatsApp: incoming messages POST directly to /webhooks/twilio/inbound,
 * and we send replies with twilioClient.messages.create.
 *
 * Conversations are identified by the customer's phone number (one conversation
 * per contact). We store a synthetic conversation id "pm:<phone>" in
 * Conversation.twilioConversationSid to keep that column populated + unique
 * without a schema change.
 */

export function syntheticConversationSid(phoneE164: string): string {
  return `pm:${phoneE164}`;
}

export async function sendWhatsAppText(opts: {
  toPhone: string; // E.164 with leading +
  body: string;
  statusCallbackUrl?: string;
}): Promise<{ sid: string }> {
  const msg = await twilioClient.messages.create({
    from: env.TWILIO_WHATSAPP_SENDER, // "whatsapp:+E.164"
    to: `whatsapp:${opts.toPhone}`,
    body: opts.body,
    statusCallback: opts.statusCallbackUrl,
  });
  return { sid: msg.sid };
}

/**
 * Map Twilio's message status strings to our MessageStatus enum.
 * Unknown statuses fall through to null (caller ignores).
 */
export function mapTwilioStatus(twilioStatus: string | undefined): MessageStatus | null {
  switch (twilioStatus) {
    case 'accepted':
    case 'queued':
    case 'scheduled':
    case 'sending':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'undelivered':
    case 'failed':
      return 'failed';
    case 'received':
      return 'received';
    default:
      return null;
  }
}

/** Rank for monotonic status updates — never downgrade (deep-dive §2). */
export function statusRank(s: MessageStatus): number {
  const ranks: Record<MessageStatus, number> = {
    queued: 0,
    sent: 1,
    delivered: 2,
    read: 3,
    received: 1,
    failed: 99,
  };
  return ranks[s];
}
