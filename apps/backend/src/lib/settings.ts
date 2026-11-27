import { prisma } from '../db/prisma';
import type { Prisma } from '@prisma/client';

/**
 * App-wide settings, stored as one JSON row (`app_settings.key = 'app'`) and
 * deep-merged over DEFAULTS on read. Adding a new setting therefore needs no
 * migration: it simply appears with its default until the operator changes it.
 *
 * `features` are UI on/off switches. The away message and the AI agent are
 * engines with their own `enabled` switch inside their own section.
 */

export type DayKey = '0' | '1' | '2' | '3' | '4' | '5' | '6'; // 0 = Sunday

export interface DayHours {
  on: boolean;
  from: string; // "09:00"
  to: string; // "18:00"
}

export interface AppSettings {
  features: {
    playbackSpeed: boolean;
    avatars: boolean;
    lastMessagePreview: boolean;
    pinChats: boolean;
    archive: boolean;
    markUnread: boolean;
    pinMessages: boolean;
    starMessages: boolean;
    forward: boolean;
    copyMessage: boolean;
    searchInChat: boolean;
    labels: boolean;
    savedReplies: boolean;
    contactNotes: boolean;
    windowTimer: boolean;
    retryFailed: boolean;
    exportChat: boolean;
    scheduleMedia: boolean;
    bulkSend: boolean;
    templateManager: boolean;
    aiAgent: boolean;
  };
  audio: {
    defaultSpeed: number; // 1 | 1.5 | 2
  };
  businessHours: {
    timezone: string;
    days: Record<DayKey, DayHours>;
  };
  away: {
    enabled: boolean;
    text: string;
    /** 'outsideHours' = only outside business hours; 'always' = every new inbound. */
    when: 'outsideHours' | 'always';
    /** Don't send the away message to the same chat again within this many hours. */
    cooldownHours: number;
  };
  ai: {
    enabled: boolean; // master switch — off stops every chat's agent at once
    model: string;
    effort: 'low' | 'medium' | 'high';
    businessInfo: string; // facts every agent may use (hours, prices, address…)
    globalInstructions: string; // tone / rules for all chats
    defaultMode: 'auto' | 'suggest';
    /** Wait this long after the last inbound before answering, so bursts are answered once. */
    replyDelaySeconds: number;
    /** After the operator writes by hand, the agent stays quiet in that chat this long. */
    pauseAfterOperatorMinutes: number;
    historyMessages: number;
    /** Stored server-side only; never sent back to the browser. */
    apiKey: string;
  };
}

const workday: DayHours = { on: true, from: '09:00', to: '18:00' };

export const DEFAULTS: AppSettings = {
  features: {
    playbackSpeed: true,
    avatars: true,
    lastMessagePreview: true,
    pinChats: true,
    archive: true,
    markUnread: true,
    pinMessages: true,
    starMessages: true,
    forward: true,
    copyMessage: true,
    searchInChat: true,
    labels: true,
    savedReplies: true,
    contactNotes: true,
    windowTimer: true,
    retryFailed: true,
    exportChat: true,
    scheduleMedia: true,
    bulkSend: true,
    templateManager: true,
    aiAgent: true,
  },
  audio: { defaultSpeed: 1 },
  businessHours: {
    timezone: 'Asia/Jerusalem',
    days: {
      '0': { ...workday },
      '1': { ...workday },
      '2': { ...workday },
      '3': { ...workday },
      '4': { ...workday },
      '5': { on: true, from: '09:00', to: '13:00' },
      '6': { on: false, from: '09:00', to: '18:00' },
    },
  },
  away: {
    enabled: false,
    text: 'Thanks for your message! We are currently closed and will get back to you as soon as we open.',
    when: 'outsideHours',
    cooldownHours: 12,
  },
  ai: {
    enabled: false,
    model: 'claude-opus-5-5',
    effort: 'medium',
    businessInfo: '',
    globalInstructions:
      'Be polite, short and helpful. Answer in the language the customer writes in. ' +
      'Never invent prices, dates or promises that are not in the information you were given.',
    defaultMode: 'auto',
    replyDelaySeconds: 20,
    pauseAfterOperatorMinutes: 60,
    historyMessages: 30,
    apiKey: '',
  },
};

export const AI_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;

const KEY = 'app';
const CACHE_MS = 10_000;
let cache: { at: number; value: AppSettings } | null = null;

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Overlay `patch` onto `base`, keeping only keys that exist in `base` with the same kind of value. */
function mergeKnown<T>(base: T, patch: unknown): T {
  if (!isPlain(base) || !isPlain(patch)) return base;
  const out: Plain = { ...base };
  for (const [k, baseVal] of Object.entries(base)) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (isPlain(baseVal)) out[k] = mergeKnown(baseVal, v);
    else if (typeof v === typeof baseVal) out[k] = v;
  }
  return out as T;
}

export async function getSettings(): Promise<AppSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  const value = mergeKnown(DEFAULTS, row?.value ?? {});
  cache = { at: Date.now(), value };
  return value;
}

export async function updateSettings(patch: unknown): Promise<AppSettings> {
  const current = await getSettings();
  const next = mergeKnown(current, patch);

  // Clamp the numbers the engines depend on, so a typo can't make the agent
  // fire instantly in a loop or the away message spam a chat.
  next.audio.defaultSpeed = [1, 1.5, 2].includes(next.audio.defaultSpeed) ? next.audio.defaultSpeed : 1;
  next.away.cooldownHours = clamp(next.away.cooldownHours, 0, 24 * 30);
  next.ai.replyDelaySeconds = clamp(next.ai.replyDelaySeconds, 0, 600);
  next.ai.pauseAfterOperatorMinutes = clamp(next.ai.pauseAfterOperatorMinutes, 0, 24 * 60 * 7);
  next.ai.historyMessages = clamp(next.ai.historyMessages, 5, 100);
  if (!(AI_MODELS as readonly string[]).includes(next.ai.model)) next.ai.model = DEFAULTS.ai.model;
  if (!['low', 'medium', 'high'].includes(next.ai.effort)) next.ai.effort = 'medium';
  if (!['auto', 'suggest'].includes(next.ai.defaultMode)) next.ai.defaultMode = 'auto';
  if (!['outsideHours', 'always'].includes(next.away.when)) next.away.when = 'outsideHours';

  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as unknown as Prisma.InputJsonValue },
    update: { value: next as unknown as Prisma.InputJsonValue },
  });
  cache = { at: Date.now(), value: next };
  return next;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Settings as sent to the browser: secrets removed, presence flags added. */
export function publicSettings(s: AppSettings) {
  const { apiKey, ...ai } = s.ai;
  return {
    ...s,
    ai: { ...ai, hasApiKey: Boolean(apiKey || process.env.ANTHROPIC_API_KEY), apiKeyFromEnv: !apiKey && Boolean(process.env.ANTHROPIC_API_KEY) },
  };
}

/** Wall-clock parts of `date` in a time zone. */
function zonedParts(date: Date, timeZone: string): { day: DayKey; minutes: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const day = String(Math.max(0, days.indexOf(get('weekday')))) as DayKey;
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function isWithinBusinessHours(s: AppSettings, at: Date = new Date()): boolean {
  const { day, minutes } = zonedParts(at, s.businessHours.timezone);
  const d = s.businessHours.days[day];
  if (!d?.on) return false;
  const from = toMinutes(d.from);
  const to = toMinutes(d.to);
  // A range like 20:00–02:00 crosses midnight.
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}
