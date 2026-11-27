import OpenAI from 'openai';
import crypto from 'node:crypto';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';
import { getSettings, isWithinBusinessHours, type AppSettings } from './settings';
import { windowState } from './window';
import { aiActiveNow } from './serialize';
import { deliverText } from './deliverText';
import { withOutbox } from '../realtime/outbox';
import { emitEphemeral } from '../realtime/io';
import { loadToolBox, type ToolBox } from './aiActions';

/**
 * AI agent (OpenAI) — answers customers in the chats the operator switched it
 * on for, and powers the operator's own "Ask AI" assistant.
 *
 * Per chat: instructions, "good to know" customer info, auto-send vs. draft,
 * an always-on or date-limited range, a business-hours rule and a daily cap.
 * Globally: master switch, business info, house rules, model, reply delay and
 * a pause after the operator writes by hand.
 *
 * The model may call the configured actions (MailerLite, HTTP endpoints)
 * before answering, then returns a fixed JSON decision; it may hand the chat
 * to a human instead of guessing.
 */

export interface AiDecision {
  action: 'reply' | 'handoff' | 'ignore';
  reply: string;
  reason: string;
}

const DECISION_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'decision',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['reply', 'handoff', 'ignore'] },
        reply: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['action', 'reply', 'reason'],
      additionalProperties: false,
    },
  },
};

/** Models that take reasoning_effort (the reasoning families). */
const isReasoningModel = (m: string) => /^(o\d|gpt-5|gpt-6)/.test(m);

const MAX_TOOL_ROUNDS = 6;
const timers = new Map<string, NodeJS.Timeout>();

function clientFor(s: AppSettings): OpenAI | null {
  const apiKey = s.ai.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, maxRetries: 2, timeout: 120_000 });
}

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * One model turn with tool use: keeps calling actions until the model answers
 * (or the round limit is hit), then returns its final text.
 */
async function complete(
  s: AppSettings,
  messages: Msg[],
  toolbox: ToolBox | null,
  json: boolean,
): Promise<string> {
  const client = clientFor(s);
  if (!client) throw new Error('No OpenAI API key is set (Settings → AI agent).');
  const convo = [...messages];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const allowTools = toolbox && toolbox.tools.length > 0 && round < MAX_TOOL_ROUNDS;
    const r = await client.chat.completions.create({
      model: s.ai.model,
      messages: convo,
      max_completion_tokens: 8000,
      ...(isReasoningModel(s.ai.model) ? { reasoning_effort: s.ai.effort } : {}),
      ...(allowTools ? { tools: toolbox!.tools } : {}),
      ...(json ? { response_format: DECISION_FORMAT } : {}),
    });
    const choice = r.choices[0];
    const msg = choice?.message;
    if (!msg) throw new Error('The AI returned an empty response.');
    if (msg.refusal) throw new Error(`The AI declined: ${msg.refusal}`);
    const calls = msg.tool_calls?.filter((c) => c.type === 'function') ?? [];
    if (calls.length && toolbox) {
      convo.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      const results = await Promise.all(calls.map((c) => toolbox.call(c.function.name, c.function.arguments)));
      calls.forEach((c, i) => convo.push({ role: 'tool', tool_call_id: c.id, content: results[i]! }));
      continue;
    }
    if (choice.finish_reason === 'length') throw new Error('The AI answer was cut off (too long).');
    return msg.content ?? '';
  }
  throw new Error('The AI kept calling actions without answering.');
}

/** Why the agent would NOT answer this chat right now, or null if it would. */
export async function blockedReason(conversationId: string, s?: AppSettings): Promise<string | null> {
  const settings = s ?? (await getSettings());
  if (!settings.features.aiAgent) return 'The AI agent feature is switched off in Settings.';
  if (!settings.ai.enabled) return 'The AI agent master switch is off (Settings → AI agent).';
  if (!settings.ai.apiKey && !process.env.OPENAI_API_KEY) return 'No OpenAI API key is set (Settings → AI agent).';
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

const section = (title: string, body?: string | null) => (body?.trim() ? `\n\n## ${title}\n${body.trim()}` : '');

/** The chat as model messages (customer = user, business = assistant). */
async function chatTranscript(conversationId: string, s: AppSettings): Promise<Msg[]> {
  const history = await prisma.message.findMany({
    where: { conversationId, type: { notIn: ['reaction', 'system'] } },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    take: s.ai.historyMessages,
  });
  history.reverse();
  const stamp = (d: Date) => d.toLocaleString('he-IL', { timeZone: s.businessHours.timezone, dateStyle: 'short', timeStyle: 'short' });
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of history) {
    const text = [m.mediaUrl ? mediaLabel(m.type) : null, m.body?.trim() || null].filter(Boolean).join(' ') || mediaLabel(m.type);
    const role = m.direction === 'inbound' ? 'user' : 'assistant';
    const line = `[${stamp(m.sentAt)}] ${text}`;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${line}`;
    else out.push({ role, content: line });
  }
  return out;
}

/** Ask the model what to do in this chat. Pure: sends nothing to the customer. */
export async function decide(
  conversationId: string,
  opts: { extraInstruction?: string } = {},
): Promise<AiDecision & { actionsUsed: ToolBox['log'] }> {
  const s = await getSettings();
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { aiConfig: true, contact: true, labels: { include: { label: true } } },
  });
  if (!conv) throw new Error('Chat not found.');

  const transcript = await chatTranscript(conversationId, s);
  if (!transcript.length) throw new Error('This chat has no messages yet.');
  if (transcript[transcript.length - 1]!.role === 'assistant') {
    transcript.push({ role: 'user', content: '(The customer has not written since the last business message. Decide whether a follow-up is needed; usually "ignore".)' });
  }

  const tz = s.businessHours.timezone;
  const now = new Date().toLocaleString('he-IL', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
  const name = conv.contact.displayName ?? conv.contact.profileName ?? 'the customer';
  const cfg = conv.aiConfig;
  const toolbox = await loadToolBox('customer');
  const system =
    `You are the WhatsApp assistant of a business, writing directly to a customer on the business's behalf. ` +
    `Each message below starts with its date and time in [brackets]; never write those brackets yourself.\n\n` +
    `Decide one action:\n` +
    `- "reply": write the WhatsApp message to send (plain text, WhatsApp *bold*/_italic_ allowed, no markdown headings, short like a person typing on a phone).\n` +
    `- "handoff": the customer needs a human — you lack the information, it needs a decision, a complaint, a payment problem, or they asked for a person. Put a short note for the business owner in "reason"; "reply" may hold a brief holding message for the customer or be empty.\n` +
    `- "ignore": nothing needs answering (e.g. "thanks", an emoji, a closing message). Leave "reply" empty.\n` +
    `Use only facts given below, already stated in the chat, or returned by the tools you have. Never invent prices, availability, dates, policies or promises.\n` +
    `Current time: ${now} (${tz}). Customer's name: ${name}. Customer's phone: ${conv.contact.phoneNumber}.` +
    section('About the business', s.ai.businessInfo) +
    section('House rules for every chat', s.ai.globalInstructions) +
    section('Instructions for this chat', cfg?.instructions) +
    section('Good to know about this customer', [cfg?.customerInfo, conv.contact.notes].filter(Boolean).join('\n')) +
    section('Labels on this chat', conv.labels.map((l) => l.label.name).join(', ')) +
    section('Extra instruction for this answer', opts.extraInstruction);

  const raw = await complete(s, [{ role: 'system', content: system }, ...transcript], toolbox, true);
  let out: AiDecision;
  try {
    out = JSON.parse(raw) as AiDecision;
  } catch {
    throw new Error('The AI returned an answer in the wrong format.');
  }
  return { action: out.action, reply: (out.reply ?? '').trim(), reason: (out.reason ?? '').trim(), actionsUsed: toolbox.log };
}

/**
 * The operator's own assistant ("Ask AI"): free questions, may use every
 * enabled action (e.g. "what was the open rate of the last newsletter?").
 * With a chat open, that chat is given as context.
 */
export async function askAssistant(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  conversationId?: string | null,
): Promise<{ answer: string; actionsUsed: ToolBox['log'] }> {
  const s = await getSettings();
  const toolbox = await loadToolBox('operator');
  let chatContext = '';
  if (conversationId) {
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true } });
    if (conv) {
      const t = await chatTranscript(conversationId, s);
      const who = conv.contact.displayName ?? conv.contact.profileName ?? conv.contact.phoneNumber;
      chatContext = section(
        `The chat currently open (with ${who}, ${conv.contact.phoneNumber}; "Customer" = them, "Business" = us)`,
        t.map((m) => `${m.role === 'user' ? 'Customer' : 'Business'}: ${m.content}`).join('\n'),
      );
    }
  }
  const tz = s.businessHours.timezone;
  const system =
    `You are the assistant of the owner of a business that talks to customers on WhatsApp. ` +
    `Answer the owner's questions briefly and clearly, in the language they write in. ` +
    `Use the available tools to look things up instead of guessing; say plainly when a tool failed or you don't know. ` +
    `Current time: ${new Date().toLocaleString('he-IL', { timeZone: tz })} (${tz}).` +
    section('About the business', s.ai.businessInfo) +
    chatContext;
  const answer = await complete(s, [{ role: 'system', content: system }, ...history.slice(-20)], toolbox, false);
  return { answer: answer.trim(), actionsUsed: toolbox.log };
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

  let decision: Awaited<ReturnType<typeof decide>>;
  try {
    decision = await decide(conversationId);
  } catch (err) {
    const message = errorText(err);
    logger.error({ err, conversationId }, 'AI agent decide failed');
    emitEphemeral('ai.error', conversationId, { conversationId, message });
    return;
  }

  await prisma.auditEvent.create({
    data: {
      kind: `ai.${decision.action}`,
      payload: { conversationId, reason: decision.reason, mode: conv.aiConfig.mode, actions: decision.actionsUsed },
    },
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
  if (err instanceof OpenAI.AuthenticationError) return 'The OpenAI API key was rejected. Check it in Settings → AI agent.';
  if (err instanceof OpenAI.PermissionDeniedError) return 'This API key has no access to the selected model.';
  if (err instanceof OpenAI.NotFoundError) return 'The selected model does not exist for this account. Pick another in Settings → AI agent.';
  if (err instanceof OpenAI.RateLimitError) return 'OpenAI is rate-limiting requests (or the account is out of credit). Try again later.';
  if (err instanceof OpenAI.BadRequestError) return `OpenAI rejected the request: ${err.message}`;
  if (err instanceof OpenAI.APIConnectionError) return 'Could not reach OpenAI (network).';
  if (err instanceof OpenAI.APIError) return `OpenAI error ${err.status ?? ''}: ${err.message}`;
  return err instanceof Error ? err.message : 'Unknown AI error.';
}

/** Tiny request used by the "Test connection" button. */
export async function testConnection(): Promise<{ ok: true; model: string }> {
  const s = await getSettings();
  const answer = await complete(s, [{ role: 'user', content: 'Reply with the single word: OK' }], null, false);
  return { ok: true, model: `${s.ai.model} — “${answer.slice(0, 20)}”` };
}

/** Chat models available to this API key, for the model picker. */
export async function listModels(): Promise<string[]> {
  const s = await getSettings();
  const client = clientFor(s);
  if (!client) return [];
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids
    .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding|codex|instruct)/.test(id))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}
