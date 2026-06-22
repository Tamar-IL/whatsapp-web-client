/**
 * Forwards inbound WhatsApp media to a Make.com (Integromat) webhook.
 *
 * Audio files are converted to MP3 before sending so Gmail renders an inline
 * audio player (play-triangle in the email body, no download needed).
 *
 * Messages are debounced per contact: bursts within DEBOUNCE_MS are batched
 * into one HTTP call → one email per conversation burst.
 *
 * Payload: multipart/form-data
 *   phone, senderName, count
 *   sentAt_N, type_N, file_N   (one set per item)
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
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

const ffmpegPath = ffmpegStatic as unknown as string | null;

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

  // Convert audio items to MP3 so Gmail shows an inline player.
  const prepared = await Promise.all(items.map(prepareItem));

  const webhookUrl = env.MAKE_WEBHOOK_URL!;
  const form = new FormData();

  const first = prepared[0]!;
  form.append('phone', first.phone);
  form.append('senderName', first.senderName);
  form.append('count', String(prepared.length));

  for (let i = 0; i < prepared.length; i++) {
    const it = prepared[i]!;
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
    logger.info({ phone: key, count: prepared.length, status: res.status }, 'make-webhook sent');
  } catch (err) {
    logger.error({ err, phone: key }, 'make-webhook flush failed');
  }
}

/** Convert audio to MP3 for inline Gmail playback; pass everything else through. */
async function prepareItem(item: MediaItem): Promise<MediaItem> {
  if (item.type !== 'audio') return item;
  if (!ffmpegPath) return item;
  // Already MP3 — no conversion needed.
  if (item.mime === 'audio/mpeg') return item;

  try {
    const mp3 = await convertToMp3(item.buf);
    return { ...item, buf: mp3, mime: 'audio/mpeg', name: 'voice_message.mp3' };
  } catch (err) {
    logger.warn({ err }, 'make-webhook: audio conversion failed, sending original');
    return item;
  }
}

async function convertToMp3(input: Buffer): Promise<Buffer> {
  const work = path.join(os.tmpdir(), 'wweb-mp3');
  await fs.mkdir(work, { recursive: true });
  const id = crypto.randomUUID();
  const inPath = path.join(work, `${id}.in`);
  const outPath = path.join(work, `${id}.mp3`);

  await fs.writeFile(inPath, input);
  try {
    await runFfmpeg([
      '-y', '-i', inPath,
      '-c:a', 'libmp3lame',
      '-q:a', '4',       // VBR ~165 kbps — good quality, small file
      '-ac', '1',        // mono (WhatsApp voice is always mono)
      outPath,
    ]);
    return await fs.readFile(outPath);
  } finally {
    await Promise.all([
      fs.rm(inPath, { force: true }).catch(() => undefined),
      fs.rm(outPath, { force: true }).catch(() => undefined),
    ]);
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath!, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

function mimeToExt(mime: string): string {
  const base = (mime.split(';')[0] ?? mime).trim();
  const map: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
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
