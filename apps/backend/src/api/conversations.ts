import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler';
import { prisma } from '../db/prisma';
import { conversationInclude, loadConversation, serializeConversation } from '../lib/serialize';
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
      include: conversationInclude,
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
        include: conversationInclude,
      });
      await emit({ kind: 'conversation.added', conversationId: conv.id, payload: { conversationId: conv.id } });
      return conv;
    });

    res.status(201).json({ conversation: serializeConversation(conversation), existing: false });
  }),
);

/**
 * GET /api/conversations — pinned first, then by last message.
 *   ?archived=1   → only archived chats (otherwise archived ones are hidden)
 *   ?labelId=…    → only chats carrying that label
 */
conversationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const archived = req.query.archived === '1';
    const labelId = typeof req.query.labelId === 'string' && req.query.labelId ? req.query.labelId : undefined;
    const conversations = await prisma.conversation.findMany({
      take: limit,
      where: {
        isArchived: archived,
        ...(labelId ? { labels: { some: { labelId } } } : {}),
      },
      orderBy: [{ isPinned: 'desc' }, { lastMessageAt: { sort: 'desc', nulls: 'last' } }],
      include: conversationInclude,
    });
    const archivedCount = archived ? conversations.length : await prisma.conversation.count({ where: { isArchived: true } });
    res.json({ conversations: conversations.map(serializeConversation), archivedCount });
  }),
);

/** GET /api/conversations/:id — single conversation detail for the header and info panel. */
conversationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const c = await loadConversation(req.params.id!);
    if (!c) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');
    res.json({ conversation: serializeConversation(c) });
  }),
);

const patchSchema = z.object({
  isPinned: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  markedUnread: z.boolean().optional(),
  needsHuman: z.boolean().optional(),
  /** Resume a paused AI agent right away. */
  resumeAi: z.boolean().optional(),
  /** Throw away the pending AI draft. */
  clearAiSuggestion: z.boolean().optional(),
});

/** PATCH /api/conversations/:id — pin / archive / mark unread / AI flags. */
conversationsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid update.');
    const p = parsed.data;
    const exists = await prisma.conversation.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');

    await withOutbox(async (tx, emit) => {
      await tx.conversation.update({
        where: { id },
        data: {
          ...(p.isPinned !== undefined && { isPinned: p.isPinned }),
          // Archiving also unpins: a pinned chat hidden in the archive is a contradiction.
          ...(p.isArchived !== undefined && { isArchived: p.isArchived, ...(p.isArchived ? { isPinned: false } : {}) }),
          ...(p.markedUnread !== undefined && { markedUnread: p.markedUnread }),
          ...(p.needsHuman !== undefined && { needsHuman: p.needsHuman }),
          ...(p.resumeAi && { aiPausedUntil: null }),
          ...(p.clearAiSuggestion && { aiSuggestion: null, aiSuggestionAt: null }),
        },
      });
      await emit({ kind: 'conversation.updated', conversationId: id, payload: p });
    });
    const c = await loadConversation(id);
    res.json({ conversation: c ? serializeConversation(c) : null });
  }),
);

/** PUT /api/conversations/:id/labels — replace the chat's labels. */
conversationsRouter.put(
  '/:id/labels',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const parsed = z.object({ labelIds: z.array(z.string()).max(50) }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'BAD_INPUT', 'Invalid labels.');
    const valid = await prisma.label.findMany({ where: { id: { in: parsed.data.labelIds } }, select: { id: true } });
    await withOutbox(async (tx, emit) => {
      await tx.conversationLabel.deleteMany({ where: { conversationId: id } });
      if (valid.length) {
        await tx.conversationLabel.createMany({ data: valid.map((l) => ({ conversationId: id, labelId: l.id })) });
      }
      await emit({ kind: 'conversation.updated', conversationId: id, payload: { labels: true } });
    });
    const c = await loadConversation(id);
    res.json({ conversation: c ? serializeConversation(c) : null });
  }),
);

/** GET /api/conversations/:id/search?q= — find messages in one chat (newest first). */
conversationsRouter.get(
  '/:id/search',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const q = String(req.query.q ?? '').trim();
    if (q.length < 1) {
      res.json({ results: [] });
      return;
    }
    const rows = await prisma.message.findMany({
      where: {
        conversationId: id,
        type: { not: 'reaction' },
        OR: [
          { body: { contains: q, mode: 'insensitive' } },
          { mediaName: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { id: true, body: true, mediaName: true, type: true, direction: true, sentAt: true },
    });
    res.json({ results: rows });
  }),
);

/** GET /api/conversations/:id/pinned — pinned messages, most recently pinned first. */
conversationsRouter.get(
  '/:id/pinned',
  asyncHandler(async (req, res) => {
    const rows = await prisma.message.findMany({
      where: { conversationId: req.params.id!, isPinned: true },
      orderBy: { pinnedAt: 'desc' },
      select: { id: true, body: true, type: true, direction: true, sentAt: true, mediaName: true, pinnedAt: true },
    });
    res.json({ pinned: rows });
  }),
);

/**
 * GET /api/conversations/:id/export?format=txt|html — the whole chat as a
 * download. `html` is a print-ready page: open it and "Save as PDF".
 */
conversationsRouter.get(
  '/:id/export',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const c = await prisma.conversation.findUnique({ where: { id }, include: { contact: true } });
    if (!c) throw new ApiError(404, 'NOT_FOUND', 'Conversation not found.');
    const messages = await prisma.message.findMany({
      where: { conversationId: id, type: { not: 'reaction' } },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
    });
    const name = c.contact.displayName ?? c.contact.profileName ?? c.contact.phoneNumber;
    const fmt = (d: Date) =>
      d.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' });
    const label = (m: (typeof messages)[number]) => {
      const media = m.mediaUrl ? `[${m.type}${m.mediaName ? `: ${m.mediaName}` : ''}] ` : '';
      return `${media}${m.body ?? ''}`.trim() || `[${m.type}]`;
    };
    const who = (m: (typeof messages)[number]) => (m.direction === 'outbound' ? 'Me' : name);
    const safeName = name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'chat';

    if (req.query.format === 'html') {
      const esc = (t: string) =>
        t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
      const rows = messages
        .map(
          (m) =>
            `<div class="m ${m.direction}"><div class="b">${esc(label(m))}</div><div class="t">${esc(fmt(m.sentAt))}</div></div>`,
        )
        .join('\n');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!doctype html><html dir="auto"><head><meta charset="utf-8"><title>${esc(name)}</title>
<style>body{font-family:"Segoe UI",Arial,sans-serif;background:#EFEAE2;margin:0;padding:24px;color:#111B21}
h1{font-size:18px;margin:0 0 4px}p.s{color:#667781;font-size:12px;margin:0 0 16px}
.m{max-width:75%;margin:4px 0;padding:6px 10px;border-radius:8px;box-shadow:0 1px 1px rgba(0,0,0,.08);font-size:14px;break-inside:avoid}
.inbound{background:#fff;margin-right:auto}.outbound{background:#D9FDD3;margin-left:auto}
.t{font-size:10px;color:#667781;text-align:end;margin-top:2px}.wrap{display:flex;flex-direction:column}
@media print{body{background:#fff}}</style></head>
<body><h1>${esc(name)}</h1><p class="s">${esc(c.contact.phoneNumber)} · ${messages.length} messages · exported ${esc(fmt(new Date()))}</p>
<div class="wrap">${rows}</div><script>window.onload=()=>setTimeout(()=>window.print(),300)</script></body></html>`);
      return;
    }

    const text =
      `${name} (${c.contact.phoneNumber})\n\n` +
      messages.map((m) => `[${fmt(m.sentAt)}] ${who(m)}: ${label(m)}`).join('\n') +
      '\n';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.txt`);
    res.send(text);
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
    // `fromId`: load everything from that message up to the newest one, so a
    // search hit / pinned message deep in the history can be jumped to.
    const fromId = req.query.fromId as string | undefined;

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

    let messages;
    if (fromId) {
      const anchor = await prisma.message.findFirst({ where: { id: fromId, conversationId: id }, select: { sentAt: true, id: true } });
      if (!anchor) throw new ApiError(404, 'NOT_FOUND', 'Message not found.');
      messages = await prisma.message.findMany({
        where: {
          conversationId: id,
          OR: [{ sentAt: { gt: anchor.sentAt } }, { sentAt: anchor.sentAt, id: { gte: anchor.id } }],
        },
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
        take: 3000,
      });
    } else {
      messages = await prisma.message.findMany({
        where: { conversationId: id, ...cursor },
        orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
    }

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
          isPinned: m.isPinned,
          isStarred: m.isStarred,
          origin: m.origin,
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
      await tx.conversation.update({ where: { id }, data: { unreadCount: 0, markedUnread: false } });
      await emit({ kind: 'conversation.updated', conversationId: id, payload: { unreadCount: 0 } });
    });

    res.json({ ok: true });
  }),
);
