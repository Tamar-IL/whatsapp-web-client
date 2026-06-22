/**
 * Forwards inbound WhatsApp media to a Make.com (Integromat) webhook.
 *
 * Messages are debounced per contact: if several arrive within DEBOUNCE_MS of
 * each other they are batched into a single HTTP call, so the operator gets
 * one email per burst rather than one per file.
 *
 * Each flush sends multipart/form-data with:
 *   phone, senderName, count
 *   sentAt_N, type_N, file_N   (one set per queued item)
 */

import { logger } from '../config/logger';
import { env } from '../config/env';

export interface MediaItem {
  senderName: string;
  phone: string;
  sentAt: Date;
  type: string;   // 'audio' | 'image' | 'video' | 'document'
  mime: string;
  name: string | null;
  buf: Buffer;
}

const queue = new Map<string, MediaItem[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 8_000;

export function queueMediaForWebhook(item: MediaItem): void {
  if (!env.MAKE_WEBHOOK_URL) return;

  const key = item.phone;
  if (!queue.has(key)) queue.set(key, []);
  queue.get(key)!.push(item);

  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(key, setTimeout(() => void flush(key), DEBOUNCE_MS));
}

async function flush(key: string): Promise<void> {
  timers.delete(key);
  const items = queue.get(key) ?? [];
  queue.delete(key);
  if (!items.length) return;

  const webhookUrl = env.MAKE_WEBHOOK_URL!;
  const form = new FormData();

  const first = items[0]!;
  form.append('phone', first.phone);
  form.append('senderName', first.senderName);
  form.append('count', String(items.length));

  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const filename = it.name ?? `media_${i}${mimeToExt(it.mime)}`;
    form.append(`sentAt_${i}`, it.sentAt.toISOString());
    form.append(`type_${i}`, it.type);
    form.append(`file_${i}`, new Blob([it.buf], { type: it.mime }), filename);
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    logger.info({ phone: key, count: items.length, status: res.status }, 'make-webhook sent');
  } catch (err) {
    logger.error({ err, phone: key }, 'make-webhook flush failed');
  }
}

function mimeToExt(mime: string): string {
  const base = (mime.split(';')[0] ?? mime).trim();
  const map: Record<string, string> = {
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/aac': '.aac',
    'audio/amr': '.amr',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
    'application/pdf': '.pdf',
  };
  return map[base] ?? '';
}
