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

/**
 * Twilio's Message resource accepts no reply-context parameter, so an outbound
 * quote cannot be attached as metadata the way an inbound one arrives (WhatsApp
 * itself supports this via Meta's Cloud API `context.message_id`; Twilio simply
 * does not expose it). The quote is therefore flattened INTO the body using
 * WhatsApp's own "> " blockquote formatting, so the customer at least sees what
 * is being replied to instead of a context-free "3pm".
 *
 * What this is not: it is not a real reply. It does not link to the original,
 * is not tappable, and shows no "replying to ‹name›" header. It is our message
 * with the quoted line rendered above it.
 */

/** WhatsApp's quote bubble shows about one line before eliding — match that. */
const QUOTE_MAX_CHARS = 80;

/** Twilio rejects a WhatsApp body over 1600 characters. */
const TWILIO_BODY_MAX = 1600;

/** What WhatsApp shows when the quoted message has no text of its own. */
function mediaQuoteLabel(type: string): string {
  switch (type) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'audio':
    case 'voice':
      return '🎤 Voice message';
    case 'document':
      return '📄 Document';
    case 'location':
      return '📍 Location';
    default:
      return 'Message';
  }
}

/**
 * Render the quoted message as a single "> …" line.
 *
 * Newlines are collapsed to spaces first: a multi-line quote would need "> " on
 * every line to stay inside the blockquote, and an unprefixed continuation line
 * would silently fall out of it and read as part of the operator's own message.
 * One line also matches what WhatsApp's own quote bubble shows.
 */
function quoteLine(target: { body: string | null; type: string }): string {
  const flat = (target.body ?? '').replace(/\s+/g, ' ').trim();
  let snippet = flat || mediaQuoteLabel(target.type);

  if (snippet.length > QUOTE_MAX_CHARS) {
    const cut = snippet.slice(0, QUOTE_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    // Break on a word boundary, unless that would hack off most of the snippet
    // (one very long word), in which case cut mid-word rather than show nothing.
    snippet = (lastSpace > QUOTE_MAX_CHARS * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
  }

  return `> ${snippet}\n`;
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

  // The quote goes on the WIRE body only. What we STORE stays exactly what the
  // operator typed: our own UI renders the quote block from replyToTwilioSid, so
  // storing the prefixed text would show the quoted line twice.
  let wireBody = input.body;
  if (replyToSnippet) {
    const prefixed = quoteLine(replyToSnippet) + input.body;
    if (prefixed.length <= TWILIO_BODY_MAX) {
      wireBody = prefixed;
    } else {
      // Never sacrifice the operator's own words to fit the quote — drop the
      // quote instead. The reply still sends; it just loses its context line.
      logger.warn(
        { conversationId: conv.id, length: prefixed.length },
        'reply too long to carry its quote — sending without it',
      );
    }
  }

  let result: { sid: string };
  try {
    result = await sendWhatsAppText({
      toPhone: conv.contact.phoneNumber,
      body: wireBody,
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
