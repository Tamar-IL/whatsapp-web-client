import type OpenAI from 'openai';
import type { AiAction } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logger } from '../config/logger';

/**
 * Actions ("tools") the AI can call while it works: look something up in
 * MailerLite, or call any HTTP endpoint the operator configures (an order
 * system, a booking calendar, a Make.com / Zapier webhook…).
 *
 * The AI only sees each action's name, description and parameters; the URL
 * and keys stay on the server. Results are cut to a few KB so a large
 * response can't flood the model.
 *
 * Safety: an action is usable in customer chats only when the operator ticks
 * "allowInCustomerChats" — otherwise only in the operator's own "Ask AI".
 * A customer can write anything, so actions that change data should stay
 * operator-only.
 */

export interface HttpParam {
  name: string;
  description: string;
  required: boolean;
}

export interface HttpConfig {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string; // may contain {param} placeholders
  headers: Record<string, string>;
  body: string; // JSON template with {param} placeholders (POST/PUT/PATCH)
  params: HttpParam[];
}

export interface MailerLiteConfig {
  apiKey: string;
}

export const SECRET_MASK = '••••••••';
const MAX_RESULT_CHARS = 6000;

type Tool = OpenAI.Chat.Completions.ChatCompletionTool;

/** The functions one action exposes to the model, keyed by function name. */
function functionsFor(a: AiAction): Array<{ fn: string; tool: Tool; run: (args: Record<string, unknown>) => Promise<unknown> }> {
  if (a.kind === 'mailerlite') {
    const cfg = a.config as unknown as MailerLiteConfig;
    const ml = (path: string) => mailerlite(cfg.apiKey, path);
    const extra = a.description ? ` ${a.description}` : '';
    return [
      {
        fn: `${a.name}__campaigns`,
        tool: {
          type: 'function',
          function: {
            name: `${a.name}__campaigns`,
            description: `MailerLite (${a.title}): recent email campaigns with their stats — sent, opens, open rate, clicks, click rate, unsubscribes.${extra}`,
            parameters: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['sent', 'draft', 'ready'], description: 'Which campaigns. Default: sent.' },
                limit: { type: 'number', description: 'How many, newest first (1–25). Default 5.' },
              },
              additionalProperties: false,
            },
          },
        },
        run: async (args) => {
          const status = typeof args.status === 'string' ? args.status : 'sent';
          const limit = Math.min(25, Math.max(1, Number(args.limit) || 5));
          const r = (await ml(`/campaigns?filter[status]=${encodeURIComponent(status)}&limit=${limit}`)) as {
            data?: Array<Record<string, unknown>>;
          };
          return (r.data ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            subject: (c.emails as Array<{ subject?: string }> | undefined)?.[0]?.subject,
            status: c.status,
            sent_at: c.finished_at ?? c.scheduled_for ?? c.created_at,
            stats: c.stats,
          }));
        },
      },
      {
        fn: `${a.name}__subscriber`,
        tool: {
          type: 'function',
          function: {
            name: `${a.name}__subscriber`,
            description: `MailerLite (${a.title}): look up one subscriber by email — status, groups, opens and clicks.${extra}`,
            parameters: {
              type: 'object',
              properties: { email: { type: 'string', description: 'Subscriber email address' } },
              required: ['email'],
              additionalProperties: false,
            },
          },
        },
        run: async (args) => ml(`/subscribers/${encodeURIComponent(String(args.email ?? ''))}`),
      },
      {
        fn: `${a.name}__groups`,
        tool: {
          type: 'function',
          function: {
            name: `${a.name}__groups`,
            description: `MailerLite (${a.title}): subscriber groups with their sizes and open / click rates.${extra}`,
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
        run: async () => ml('/groups?limit=50'),
      },
    ];
  }

  const cfg = a.config as unknown as HttpConfig;
  const props: Record<string, unknown> = {};
  for (const p of cfg.params ?? []) props[p.name] = { type: 'string', description: p.description };
  return [
    {
      fn: a.name,
      tool: {
        type: 'function',
        function: {
          name: a.name,
          description: `${a.title}. ${a.description}`.trim(),
          parameters: {
            type: 'object',
            properties: props,
            required: (cfg.params ?? []).filter((p) => p.required).map((p) => p.name),
            additionalProperties: false,
          },
        },
      },
      run: (args) => runHttp(cfg, args),
    },
  ];
}

async function mailerlite(apiKey: string, path: string): Promise<unknown> {
  if (!apiKey) throw new Error('MailerLite API key is missing.');
  const res = await fetch(`https://connect.mailerlite.com/api${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MailerLite ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function fill(template: string, args: Record<string, unknown>, encode: (s: string) => string): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in args ? encode(String(args[k] ?? '')) : m));
}

async function runHttp(cfg: HttpConfig, args: Record<string, unknown>): Promise<unknown> {
  const url = fill(cfg.url, args, encodeURIComponent);
  const hasBody = cfg.method !== 'GET' && cfg.method !== 'DELETE' && cfg.body?.trim();
  const res = await fetch(url, {
    method: cfg.method,
    headers: { Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...(cfg.headers ?? {}) },
    // Values are JSON-escaped (without the surrounding quotes) so they can sit inside "…" in the template.
    body: hasBody ? fill(cfg.body, args, (s) => JSON.stringify(s).slice(1, -1)) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface ToolBox {
  tools: Tool[];
  call: (fn: string, rawArgs: string) => Promise<string>;
  log: Array<{ action: string; ok: boolean; error?: string }>;
}

/** Load the enabled actions for this context and return them as model tools. */
export async function loadToolBox(context: 'customer' | 'operator'): Promise<ToolBox> {
  const actions = await prisma.aiAction.findMany({
    where: { enabled: true, ...(context === 'customer' ? { allowInCustomerChats: true } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  const fns = actions.flatMap((a) => functionsFor(a).map((f) => ({ ...f, title: a.title })));
  const log: ToolBox['log'] = [];
  return {
    tools: fns.map((f) => f.tool),
    log,
    call: async (fn, rawArgs) => {
      const f = fns.find((x) => x.fn === fn);
      if (!f) return JSON.stringify({ error: `Unknown action ${fn}` });
      let args: Record<string, unknown> = {};
      try {
        args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
      } catch {
        return JSON.stringify({ error: 'Arguments were not valid JSON.' });
      }
      try {
        const result = await f.run(args);
        log.push({ action: f.title, ok: true });
        const text = typeof result === 'string' ? result : JSON.stringify(result);
        return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [cut]` : text;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Action failed.';
        logger.warn({ fn, err: msg }, 'AI action failed');
        log.push({ action: f.title, ok: false, error: msg });
        return JSON.stringify({ error: msg });
      }
    },
  };
}

/** Run one action directly (the "Test" button in Settings). */
export async function testAction(a: AiAction, fn: string | undefined, args: Record<string, unknown>): Promise<unknown> {
  const list = functionsFor(a);
  const f = list.find((x) => x.fn === fn) ?? list[0];
  if (!f) throw new Error('This action has no functions.');
  return f.run(args);
}

/** Action as sent to the browser: keys and header values masked. */
export function maskAction(a: AiAction) {
  const cfg = { ...(a.config as Record<string, unknown>) };
  if (a.kind === 'mailerlite') cfg.apiKey = cfg.apiKey ? SECRET_MASK : '';
  if (a.kind === 'http' && cfg.headers && typeof cfg.headers === 'object') {
    cfg.headers = Object.fromEntries(Object.keys(cfg.headers as object).map((k) => [k, SECRET_MASK]));
  }
  return { ...a, config: cfg, functions: functionsFor(a).map((f) => f.fn) };
}
