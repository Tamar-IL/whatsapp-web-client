import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { prisma } from '../db/prisma';
import { windowState } from '../lib/window';
import { withOutbox } from '../realtime/outbox';
import { ApiError } from '../lib/errors';
import { syntheticConversationSid } from '../twilio/programmable';
import { env } from '../config/env';

export const conversationsRouter = Router();

/**
 * Normalize an operator-typed phone number to E.164 ("+972501234567").
 *
 * Accepts the forms people actually type: "+972 50-123-4567", "0501234567",
 * "00972501234567", "972501234567". A leading "0" is a national prefix — it is
 * dropped and DEFAULT_COUNTRY_CODE is prepended, because a business almost
 * always messages numbers in its own country and nobody types the +972 by hand.
 *
 * Returns null when the result could not be a valid number, so the caller can
 * refuse rather than send a template to a malformed address.
 */
export function normalizePhone(input: string): string | null {
  const cleaned = input.replace(/[\s()\-.‎‏]/g, '');

  let e164: string;
  if (cleaned.startsWith('+')) e164 = cleaned;
  else if (cleaned.startsWith('00')) e164 = `+${cleaned.slice(2)}`;
  else if (cleaned.startsWith('0')) e164 = `+${env.DEFAULT_COUNTRY_CODE}${cleaned.slice(1)}`;
  // Bare digits with no prefix are assumed to already carry a country code:
  // "972501234567". Prepending the default here would corrupt it.
  else e164 = `+${cleaned}`;

  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : null;
}

const createSchema = z.object({
  phoneNumber: z.string().min(3).max(32),
  displayName: z.string().max(120).optional(),
});

/**
 * POST /api/conversations — start a chat with a number that has never written.
 *
 * Until now a Conversation only ever came into existence from an inbound
 * webhook, so there was no way to reach a new contact at all. The conversation
 * is created with `lastInboundAt: null`, which `windowState` treats as closed —
 * so the UI correctly offers only template sending, which is exactly the rule
 * WhatsApp enforces for a business-initiated conversation.
 *
 * Idempotent: an existing chat for the same number is returned rather than
 * duplicated (`twilioConversationSid` is unique, so a blind create would throw).
 */
conversationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Enter a phone number.');

    const phoneNumber = normalizePhone(parsed.data.phoneNumber);
    if (!phoneNumber) {
      throw new ApiError(
        400,
        'BAD_PHONE',
        'That does not look like a phone number. Use 0501234567 or +972501234567.',
      );
    }

    // Messaging our own sender would create a conversation with ourselves that
    // Twilio then refuses to deliver to.
    if (phoneNumber === env.TWILIO_WHATSAPP_SENDER.replace(/^whatsapp:/, '')) {
      throw new ApiError(400, 'BAD_PHONE', 'That is this account’s own WhatsApp number.');
    }

    const twilioConversationSid = syntheticConversationSid(phoneNumber);
    const existing = await prisma.conversation.findUnique({
      where: { twilioConversationSid },
      include: { contact: true },
    });
    if (existing) {
      res.json({ conversation: serializeConversation(existing), existing: true });
      return;
    }

    const displayNameInput = parsed.data.displayName?.trim() || undefined;
    const conversation = await withOutbox(async (tx, emit) => {
      const contact = await tx.contact.upsert({
        where: { phoneNumber },
        // Don't clobber a name we already learned from WhatsApp with a blank.
        update: displayNameInput ? { displayName: displayNameInput } : {},
        create: { phoneNumber, displayName: displayNameInput },
      });
      const conv = await tx.conversation.create({
        data: { contactId: contact.id, twilioConversationSid },
        include: { contact: true },
      });
      await emit({ kind: 'conversation.added', conversationId: conv.id, payload: { conversationId: conv.id } });
      return conv;
    });

    res.status(201).json({ conversation: serializeConversation(conversation), existing: false });
  }),
);

type ConversationWithContact = {
  id: string;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  unreadCount: number;
  isPinned: boolean;
  isArchived: boolean;
  contact: {
    id: string;
    phoneNumber: string;
    displayName: string | null;
    profileName: string | null;
    optOut: boolean;
  };
};

function serializeConversation(c: ConversationWithContact) {
  return {
    id: c.id,
    contact: {
      id: c.contact.id,
      phoneNumber: c.contact.phoneNumber,
      displayName: c.contact.displayName,
      profileName: c.contact.profileName,
      optOut: c.contact.optOut,
    },
    lastMessageAt: c.lastMessageAt,
    unreadCount: c.unreadCount,
    isPinned: c.isPinned,
    isArchived: c.isArchived,
    window: windowState(c.lastInboundAt),
  };
}

/**
 * GET /api/conversations — paginated list, pinned first then by last message.
 */
conversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const conversations = await prisma.conversation.findMany({
      take: limit,
      where: { isArchived: false },
      orderBy: [{ isPinned: 'desc' }, { lastMessageAt: 'desc' }],
      include: { contact: true },
    });

    res.json({
      conversations: conversations.map((c) => ({
        id: c.id,
        contact: {
          id: c.contact.id,
          phoneNumber: c.contact.phoneNumber,
          displayName: c.contact.displayName,
          profileName: c.contact.profileName,
          optOut: c.contact.optOut,
        },
        lastMessageAt: c.lastMessageAt,
        unreadCount: c.unreadCount,
        isPinned: c.isPinned,
        isArchived: c.isArchived,
        window: windowState(c.lastInboundAt),
      })),
    });
  }),
);

/**
 * GET /api/conversations/:id — single conversation detail (contact + window),
 * used for the conversation header.
 */
conversationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const c = await prisma.conversation.findUnique({ where: { id }, include: { contact: true } });
    if (!c) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');
    res.json({
      conversation: {
        id: c.id,
        contact: {
          id: c.contact.id,
          phoneNumber: c.contact.phoneNumber,
          displayName: c.contact.displayName,
          profileName: c.contact.profileName,
          optOut: c.contact.optOut,
        },
        lastMessageAt: c.lastMessageAt,
        unreadCount: c.unreadCount,
        isPinned: c.isPinned,
        isArchived: c.isArchived,
        window: windowState(c.lastInboundAt),
      },
    });
  }),
);

/**
 * GET /api/conversations/:id/messages — reverse-chrono pagination via `before`.
 * Response is chronological (oldest → newest).
 */
conversationsRouter.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const before = req.query.before as string | undefined;
    const beforeId = req.query.beforeId as string | undefined;

    const conv = await prisma.conversation.findUnique({ where: { id }, select: { id: true } });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    // Composite cursor (sentAt, id). `sentAt` alone is NOT unique — inbound
    // messages are stamped with the webhook's receipt time, so a burst can share
    // a millisecond. Paging on `sentAt < before` then skipped every message
    // sharing the boundary timestamp, losing them from the history for good.
    // `id` breaks the tie in both the filter and the sort.
    const cursor = before
      ? beforeId
        ? {
            OR: [
              { sentAt: { lt: new Date(before) } },
              { sentAt: new Date(before), id: { lt: beforeId } },
            ],
          }
        : { sentAt: { lt: new Date(before) } }
      : {};

    const messages = await prisma.message.findMany({
      where: { conversationId: id, ...cursor },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    // Resolve quoted-reply snippets in one batched query.
    const replySids = messages
      .map((m) => m.replyToTwilioSid)
      .filter((s): s is string => Boolean(s));
    const quotedRows = replySids.length
      ? await prisma.message.findMany({
          where: { twilioSid: { in: replySids } },
          select: { id: true, twilioSid: true, body: true, direction: true, type: true },
        })
      : [];
    const quotedMap = new Map(quotedRows.map((q) => [q.twilioSid, q]));

    // Reactions on the messages in this page. They are stored as their own rows,
    // so a reaction whose target sits in an older page would otherwise be
    // invisible — fetching by target id keeps the emoji with its bubble no matter
    // which page the target loaded in.
    const reactionRows = await prisma.message.findMany({
      where: { type: 'reaction', reactsToId: { in: messages.map((m) => m.id) } },
      select: { id: true, body: true, direction: true, sentAt: true, reactsToId: true },
      orderBy: { sentAt: 'asc' },
    });
    // Newest per (target, side) wins: re-reacting replaces the emoji, and a
    // removal (empty body) clears it. Ascending order means the last write sticks.
    //
    // Removals are sent through as empty-emoji entries rather than being dropped
    // here: the client merges this list with reaction rows it already holds, and
    // it can only know a removal supersedes an emoji it has if the removal is
    // visible with its timestamp.
    type ReactionOut = { id: string; emoji: string; direction: string; sentAt: Date };
    const latestReaction = new Map<string, ReactionOut>();
    for (const r of reactionRows) {
      if (!r.reactsToId) continue;
      latestReaction.set(`${r.reactsToId}:${r.direction}`, {
        id: r.id,
        emoji: (r.body ?? '').trim(),
        direction: r.direction,
        sentAt: r.sentAt,
      });
    }
    const reactionsFor = (messageId: string) =>
      ['inbound', 'outbound']
        .map((d) => latestReaction.get(`${messageId}:${d}`))
        .filter((r): r is ReactionOut => Boolean(r));

    res.json({
      messages: messages.reverse().map((m) => {
        const quoted = m.replyToTwilioSid ? quotedMap.get(m.replyToTwilioSid) : undefined;
        return {
          id: m.id,
          clientId: m.clientId,
          direction: m.direction,
          type: m.type,
          status: m.status,
          body: m.body,
          mediaUrl: m.mediaUrl ? `/api/media/${m.id}` : null,
          mediaMime: m.mediaMime,
          mediaName: m.mediaName,
          mediaSize: m.mediaSize,
          hasMedia: Boolean(m.mediaUrl),
          errorCode: m.errorCode,
          errorMessage: m.errorMessage,
          // Quick-reply chips. Twilio echoes back only the Content SID, so the
          // labels the customer saw are replayed from our own row.
          buttons: Array.isArray(m.buttons) ? (m.buttons as string[]) : null,
          sentAt: m.sentAt,
          replyTo: quoted
            ? { id: quoted.id, body: quoted.body, direction: quoted.direction, type: quoted.type }
            : null,
          reactsToId: m.reactsToId,
          reactions: reactionsFor(m.id),
        };
      }),
    });
  }),
);

/**
 * POST /api/conversations/:id/read — zero unread_count, emit realtime update.
 */
conversationsRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const conv = await prisma.conversation.findUnique({ where: { id }, select: { id: true } });
    if (!conv) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    await withOutbox(async (tx, emit) => {
      await tx.conversation.update({ where: { id }, data: { unreadCount: 0 } });
      await emit({ kind: 'conversation.updated', conversationId: id, payload: { unreadCount: 0 } });
    });

    res.json({ ok: true });
  }),
);
