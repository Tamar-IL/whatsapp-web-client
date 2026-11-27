import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import crypto from 'node:crypto';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { getSettings, isWithinBusinessHours, type AppSettings } from './settings';
import { windowState } from './window';
import { aiActiveNow } from './serialize';
import { deliverText } from './deliverText';
import { withOutbox } from '../realtime/outbox';
import { emitEphemeral } from '../realtime/io';

/**
 * AI agent — answers customers in the chats the operator switched it on for.
 *
 * Per chat: instructions, "good to know" customer info, auto-send vs. draft,
 * an always-on or date-limited range, an optional business-hours rule and a
 * daily reply cap. Globally: a master switch, business info, house rules,
 * model, reply delay and a pause after the operator writes by hand.
 *
 * The model answers in a fixed JSON shape and may decline to answer
 * ("handoff") when it lacks the information — the chat is then flagged for a
 * human instead of the customer getting a guess.
 */

const Decision = z.object({
  action: z.enum(['reply', 'handoff', 'ignore']),
  reply: z.string(),
  reason: z.string(),
});
export type AiDecision = z.infer<typeof Decision>;

const timers = new Map<string, NodeJS.Timeout>();

function clientFor(s: AppSettings): Anthropic | null {
  const apiKey = s.ai.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
}

/** Why the agent would NOT answer this chat right now, or null if it would. */
export async function blockedReason(conversationId: string, s?: AppSettings): Promise<string | null> {
  const settings = s ?? (await getSettings());
  if (!settings.features.aiAgent) return 'The AI agent feature is switched off in Settings.';
  if (!settings.ai.enabled) return 'The AI agent master switch is off (Settings → AI agent).';
  if (!settings.ai.apiKey && !process.env.ANTHROPIC_API_KEY) return 'No Anthropic API key is set (Settings → AI agent).';
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { aiConfig: true, contact: true },
  });
  if (!conv) return 'Chat not found.';
  const cfg = conv.aiConfig;
  if (!cfg?.enabled) return 'The agent is not switched on for this chat.';
  if (!aiActiveNow(cfg)) return 'Outside the dates set for this chat.';
  if (cfg.useBusinessHours !== 'any') {
    const inside = isWithinBusinessHours(settings);
    if (cfg.useBusinessHours === 'inside' && !inside) return 'Set to answer only during business hours.';
    if (cfg.useBusinessHours === 'outside' && inside) return 'Set to answer only outside business hours.';
  }
  if (conv.aiPausedUntil && conv.aiPausedUntil > new Date()) {
    return `Paused until ${conv.aiPausedUntil.toLocaleTimeString('he-IL', { timeZone: settings.businessHours.timezone, hour: '2-digit', minute: '2-digit' })} because you replied by hand.`;
  }
  if (conv.contact.optOut) return 'The customer opted out.';
  if (cfg.mode === 'auto' && !windowState(conv.lastInboundAt).open) return 'The 24-hour window is closed.';
  if (cfg.maxRepliesPerDay != null) {
    const sent = await prisma.message.count({
      where: { conversationId, origin: 'ai', sentAt: { gt: new Date(Date.now() - 24 * 3600 * 1000) } },
    });
    if (sent >= cfg.maxRepliesPerDay) return `Daily limit of ${cfg.maxRepliesPerDay} AI replies reached.`;
  }
  return null;
}

/** Called for every inbound customer message: (re)start the chat's debounce timer. */
export function scheduleAiReply(conversationId: string, delaySeconds: number): void {
  const prev = timers.get(conversationId);
  if (prev) clearTimeout(prev);
  timers.set(
    conversationId,
    setTimeout(() => {
      timers.delete(conversationId);
      void runAgent(conversationId).catch((err) => logger.error({ err, conversationId }, 'AI agent run failed'));
    }, Math.max(0, delaySeconds) * 1000),
  );
}

function mediaLabel(type: string): string {
  return (
    { image: '[photo]', video: '[video]', audio: '[voice message]', voice: '[voice message]', document: '[document]', location: '[location]' } as Record<string, string>
  )[type] ?? `[${type}]`;
}

/** Ask the model what to do in this chat. Pure: sends nothing. */
export async function decide(conversationId: string, opts: { extraInstruction?: string } = {}): Promise<AiDecision> {
  const s = await getSettings();
  const client = clientFor(s);
  if (!client) throw new Error('No Anthropic API key is set (Settings → AI agent).');

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { aiConfig: true, contact: true, labels: { include: { label: true } } },
  });
  if (!conv) throw new Error('Chat not found.');

  const history = await prisma.message.findMany({
    where: { conversationId, type: { notIn: ['reaction', 'system'] } },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    take: s.ai.historyMessages,
  });
  history.reverse();
  if (!history.length) throw new Error('This chat has no messages yet.');

  const tz = s.businessHours.timezone;
  const stamp = (d: Date) => d.toLocaleString('he-IL', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    const text = [m.mediaUrl ? mediaLabel(m.type) : null, m.body?.trim() || null].filter(Boolean).join(' ') || mediaLabel(m.type);
    const role = m.direction === 'inbound' ? 'user' : 'assistant';
    const line = `[${stamp(m.sentAt)}] ${text}`;
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === 'string') last.content += `\n${line}`;
    else messages.push({ role, content: line });
  }
  // The API needs the conversation to start with the customer and end with them.
  while (messages[0]?.role === 'assistant') messages.shift();
  if (!messages.length) throw new Error('There is no customer message to answer yet.');
  if (messages[messages.length - 1]!.role === 'assistant') {
    messages.push({ role: 'user', content: '(The customer has not written since the last business message. Decide whether a follow-up is needed; usually "ignore".)' });
  }

  const name = conv.contact.displayName ?? conv.contact.profileName ?? 'the customer';
  const cfg = conv.aiConfig;
  const section = (title: string, body?: string | null) => (body?.trim() ? `\n\n## ${title}\n${body.trim()}` : '');
  const system =
    `You are the WhatsApp assistant of a business, writing directly to a customer on the business's behalf. ` +
    `Each customer message below starts with its date and time in [brackets]; never write those brackets yourself.\n\n` +
    `Decide one action:\n` +
    `- "reply": write the WhatsApp message to send (plain text, WhatsApp *bold*/_italic_ allowed, no markdown headings, short like a person typing on a phone).\n` +
    `- "handoff": the customer needs a human — you lack the information, it needs a decision, a complaint, a payment problem, or they asked for a person. Put a short note for the business owner in "reason"; "reply" may hold a brief holding message for the customer or be empty.\n` +
    `- "ignore": nothing needs answering (e.g. "thanks", an emoji, a closing message). Leave "reply" empty.\n` +
    `Use only facts given below or already stated in the chat. Never invent prices, availability, dates, policies or promises.\n` +
    `Current time: ${stamp(new Date())} (${tz}). Customer's name: ${name}. Customer's phone: ${conv.contact.phoneNumber}.` +
    section('About the business', s.ai.businessInfo) +
    section('House rules for every chat', s.ai.globalInstructions) +
    section('Instructions for this chat', cfg?.instructions) +
    section('Good to know about this customer', [cfg?.customerInfo, conv.contact.notes].filter(Boolean).join('\n')) +
    section('Labels on this chat', conv.labels.map((l) => l.label.name).join(', ')) +
    section('Extra instruction for this answer', opts.extraInstruction);

  const supportsFallback = s.ai.model !== 'claude-haiku-5-5';
  const response = await client.beta.messages.parse({
    model: s.ai.model,
    max_tokens: 16000,
    system,
    messages,
    output_config: { effort: s.ai.effort, format: betaZodOutputFormat(Decision) },
    ...(supportsFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  });

  if (response.stop_reason === 'refusal') {
    return { action: 'handoff', reply: '', reason: 'The AI declined to answer this conversation.' };
  }
  const out = response.parsed_output;
  if (!out) throw new Error(`The AI returned no usable answer (stop reason: ${response.stop_reason}).`);
  return { action: out.action, reply: out.reply.trim(), reason: out.reason.trim() };
}

/** Full automatic run for one chat (after the debounce). */
export async function runAgent(conversationId: string): Promise<void> {
  const s = await getSettings();
  const blocked = await blockedReason(conversationId, s);
  if (blocked) {
    logger.debug({ conversationId, blocked }, 'AI agent skipped');
    return;
  }
  // If the newest message is ours (operator answered during the delay), stay quiet.
  const newest = await prisma.message.findFirst({
    where: { conversationId, type: { not: 'reaction' } },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    select: { direction: true },
  });
  if (newest?.direction !== 'inbound') return;

  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { aiConfig: true, contact: true } });
  if (!conv?.aiConfig) return;

  let decision: AiDecision;
  try {
    decision = await decide(conversationId);
  } catch (err) {
    const message = errorText(err);
    logger.error({ err, conversationId }, 'AI agent decide failed');
    emitEphemeral('ai.error', conversationId, { conversationId, message });
    return;
  }

  await prisma.auditEvent.create({
    data: { kind: `ai.${decision.action}`, payload: { conversationId, reason: decision.reason, mode: conv.aiConfig.mode } },
  });

  if (decision.action === 'ignore') return;

  if (decision.action === 'handoff') {
    await withOutbox(async (tx, emit) => {
      await tx.conversation.update({ where: { id: conversationId }, data: { needsHuman: true, markedUnread: true } });
      await emit({ kind: 'conversation.updated', conversationId, payload: { needsHuman: true } });
    });
    emitEphemeral('ai.handoff', conversationId, { conversationId, reason: decision.reason });
  }

  if (!decision.reply) return;

  if (conv.aiConfig.mode === 'suggest') {
    await withOutbox(async (tx, emit) => {
      await tx.conversation.update({
        where: { id: conversationId },
        data: { aiSuggestion: decision.reply, aiSuggestionAt: new Date() },
      });
      await emit({ kind: 'conversation.updated', conversationId, payload: { aiSuggestion: true } });
    });
    return;
  }

  if (!windowState(conv.lastInboundAt).open) return;
  try {
    await deliverText({ conv, body: decision.reply, clientId: `ai_${crypto.randomUUID()}`, origin: 'ai' });
  } catch (err) {
    logger.error({ err, conversationId }, 'AI agent send failed');
    emitEphemeral('ai.error', conversationId, { conversationId, message: 'The AI reply could not be sent via Twilio.' });
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'The Anthropic API key was rejected. Check it in Settings → AI agent.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key has no access to the selected model.';
  if (err instanceof Anthropic.RateLimitError) return 'The AI service is rate-limiting requests. Try again in a minute.';
  if (err instanceof Anthropic.BadRequestError) return `The AI service rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the AI service (network).';
  if (err instanceof Anthropic.APIError) return `AI service error ${err.status ?? ''}: ${err.message}`;
  return err instanceof Error ? err.message : 'Unknown AI error.';
}

/** Tiny request used by the "Test connection" button. */
export async function testConnection(): Promise<{ ok: true; model: string }> {
  const s = await getSettings();
  const client = clientFor(s);
  if (!client) throw new Error('No Anthropic API key is set.');
  const r = await client.messages.create({
    model: s.ai.model,
    max_tokens: 64,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
  });
  return { ok: true, model: r.model };
}
