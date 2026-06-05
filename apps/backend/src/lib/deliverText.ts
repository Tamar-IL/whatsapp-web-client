import { prisma } from '../db/prisma';
import { withOutbox } from '../realtime/outbox';
import { sendWhatsAppText } from '../twilio/programmable';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Shared "send a free-form WhatsApp text now" delivery path.
 *
 * Used by both the live send route (api/messages.ts) and the scheduled-send
 * worker (jobs/scheduler.ts) so a scheduled message is delivered through exactly
 * the same Twilio call, Message row, outbox event and audit record as an
 * immediate one.
 *
 * Callers are responsible for the 24h window check BEFORE calling this — the
 * scheduler re-checks the window at fire time, which is the whole point of
 * scheduling.
 */

export class DeliverError extends Error {
  constructor(public twilioCode: string | undefined, message: string) {
    super(message);
    this.name = 'DeliverError';
  }
}

export interface ReplySnippet {
  id: string;
  body: string | null;
  direction: string;
  type: string;
}

export interface DeliverResult {
  message: {
    id: string;
    clientId: string | null;
    twilioSid: string;
    direction: 'outbound';
    type: 'text';
    status: string;
    body: string | null;
    sentAt: Date;
    replyTo: ReplySnippet | null;
  };
  replyTo: ReplySnippet | null;
}

export async function deliverText(input: {
  conv: { id: string; contact: { phoneNumber: string } };
  body: string;
  clientId: string;
  replyToId?: string | null;
  userId?: string | null;
}): Promise<DeliverResult> {
  const { conv } = input;

  // Resolve the message being replied to (for quoted-reply threading in our UI).
  let replyToTwilioSid: string | null = null;
  let replyToSnippet: ReplySnippet | null = null;
  if (input.replyToId) {
    const target = await prisma.message.findFirst({
      where: { id: input.replyToId, conversationId: conv.id },
      select: { id: true, twilioSid: true, body: true, direction: true, type: true },
    });
    if (target) {
      replyToTwilioSid = target.twilioSid;
      replyToSnippet = { id: target.id, body: target.body, direction: target.direction, type: target.type };
    }
  }

  const statusCallbackUrl = `${env.PUBLIC_BASE_URL}/webhooks/twilio/status`;

  let result: { sid: string };
  try {
    result = await sendWhatsAppText({
      toPhone: conv.contact.phoneNumber,
      body: input.body,
      statusCallbackUrl,
    });
  } catch (err) {
    const code = (err as { code?: string | number })?.code;
    logger.error({ err, conversationId: conv.id }, 'Twilio send failed');
    throw new DeliverError(code !== undefined ? String(code) : undefined, (err as Error)?.message ?? 'Twilio send failed');
  }

  const now = new Date();
  const message = await withOutbox(async (tx, emit) => {
    const m = await tx.message.create({
      data: {
        conversationId: conv.id,
        twilioSid: result.sid,
        clientId: input.clientId,
        direction: 'outbound',
        type: 'text',
        status: 'sent',
        body: input.body,
        replyToTwilioSid,
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
        replyTo: replyToSnippet,
      },
    });
    return m;
  });

  await prisma.auditEvent.create({
    data: { userId: input.userId ?? null, kind: 'message.sent', payload: { conversationId: conv.id } },
  });

  return {
    message: {
      id: message.id,
      clientId: message.clientId,
      twilioSid: message.twilioSid,
      direction: 'outbound',
      type: 'text',
      status: message.status,
      body: message.body,
      sentAt: message.sentAt,
      replyTo: replyToSnippet,
    },
    replyTo: replyToSnippet,
  };
}
