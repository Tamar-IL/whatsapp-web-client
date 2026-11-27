import crypto from 'node:crypto';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { getSettings, isWithinBusinessHours } from './settings';
import { windowState } from './window';
import { deliverText } from './deliverText';
import { aiActiveNow } from './serialize';
import { scheduleAiReply, blockedReason } from './aiAgent';

/**
 * Runs after every stored inbound customer message (fire-and-forget, never
 * delays the Twilio ack): the away message and the AI agent.
 */
export async function onInboundMessage(conversationId: string, isReaction: boolean): Promise<void> {
  if (isReaction) return;
  try {
    const s = await getSettings();
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true, aiConfig: true },
    });
    if (!conv) return;

    // Clear the "needs a human" flag only when a human acts — not here.
    const aiWillAnswer = aiActiveNow(conv.aiConfig) && conv.aiConfig?.mode === 'auto' && !(await blockedReason(conversationId, s));

    if (s.features.aiAgent && s.ai.enabled && aiActiveNow(conv.aiConfig)) {
      scheduleAiReply(conversationId, s.ai.replyDelaySeconds);
    }

    // Away message — skipped when the AI agent is about to answer this chat itself.
    if (s.away.enabled && s.away.text.trim() && !aiWillAnswer && !conv.contact.optOut) {
      const outside = !isWithinBusinessHours(s);
      const due = s.away.when === 'always' || outside;
      const cooled =
        !conv.lastAwaySentAt || Date.now() - conv.lastAwaySentAt.getTime() > s.away.cooldownHours * 3600 * 1000;
      if (due && cooled && windowState(conv.lastInboundAt).open) {
        await prisma.conversation.update({ where: { id: conv.id }, data: { lastAwaySentAt: new Date() } });
        await deliverText({ conv, body: s.away.text.trim(), clientId: `away_${crypto.randomUUID()}`, origin: 'away' });
      }
    }
  } catch (err) {
    logger.error({ err, conversationId }, 'inbound automation failed');
  }
}
