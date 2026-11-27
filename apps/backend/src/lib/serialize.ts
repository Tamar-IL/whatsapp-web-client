import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { windowState } from './window';
import { getSettings } from './settings';
import { withOutbox } from '../realtime/outbox';

/** Prisma include used everywhere a conversation is sent to the browser. */
export const conversationInclude = {
  contact: true,
  labels: { include: { label: true } },
  aiConfig: true,
  messages: {
    where: { type: { not: 'reaction' } },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: { id: true, body: true, type: true, direction: true, status: true, sentAt: true, origin: true },
  },
} satisfies Prisma.ConversationInclude;

export type ConversationFull = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

/** Is the chat's AI agent active right now (enabled + inside its date range)? */
export function aiActiveNow(cfg: ConversationFull['aiConfig'], now = new Date()): boolean {
  if (!cfg?.enabled) return false;
  if (cfg.rangeType === 'temporary') {
    if (cfg.activeFrom && now < cfg.activeFrom) return false;
    if (cfg.activeUntil && now > cfg.activeUntil) return false;
  }
  return true;
}

export function serializeConversation(c: ConversationFull) {
  const last = c.messages[0];
  return {
    id: c.id,
    contact: {
      id: c.contact.id,
      phoneNumber: c.contact.phoneNumber,
      displayName: c.contact.displayName,
      profileName: c.contact.profileName,
      optOut: c.contact.optOut,
      notes: c.contact.notes,
      email: c.contact.email,
    },
    lastMessageAt: c.lastMessageAt,
    lastMessage: last
      ? {
          body: last.body,
          type: last.type,
          direction: last.direction,
          status: last.status,
          sentAt: last.sentAt,
          origin: last.origin,
        }
      : null,
    unreadCount: c.unreadCount,
    markedUnread: c.markedUnread,
    isPinned: c.isPinned,
    isArchived: c.isArchived,
    needsHuman: c.needsHuman,
    aiPausedUntil: c.aiPausedUntil,
    aiSuggestion: c.aiSuggestion,
    ai: c.aiConfig
      ? {
          enabled: c.aiConfig.enabled,
          activeNow: aiActiveNow(c.aiConfig),
          mode: c.aiConfig.mode,
        }
      : null,
    labels: c.labels.map((l) => ({ id: l.label.id, name: l.label.name, color: l.label.color })),
    window: windowState(c.lastInboundAt),
  };
}

export async function loadConversation(id: string) {
  return prisma.conversation.findUnique({ where: { id }, include: conversationInclude });
}

/**
 * The operator just wrote in this chat by hand: the AI agent steps back for the
 * configured pause, its pending draft is dropped, and a "needs a human" flag is
 * cleared — a human is now handling it.
 */
export async function noteOperatorReply(conversationId: string): Promise<void> {
  const s = await getSettings();
  const pauseMs = s.ai.pauseAfterOperatorMinutes * 60_000;
  await withOutbox(async (tx, emit) => {
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        aiPausedUntil: pauseMs > 0 ? new Date(Date.now() + pauseMs) : null,
        aiSuggestion: null,
        aiSuggestionAt: null,
        needsHuman: false,
        markedUnread: false,
      },
    });
    await emit({ kind: 'conversation.updated', conversationId, payload: { reason: 'operator-reply' } });
  });
}
