import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env';

/**
 * Local media store + signed public URLs (Round 2 — outbound file sending).
 *
 * Programmable Messaging sends media by giving Twilio a PUBLIC url to fetch.
 * We can't expose our authenticated /api/media to Twilio (no session cookie),
 * so outbound files are written to disk and served from a token-protected
 * public endpoint (/public/media/:token). The token is a short-lived HMAC so
 * the URL isn't truly public — only Twilio, holding the signed link, can fetch.
 *
 * NOTE: disk is ephemeral on Railway (cleared on redeploy). That's fine for the
 * brief window Twilio needs to fetch. For our own UI we also serve these files
 * via /api/media/:id while they exist; after a redeploy old outbound media won't
 * load. Persistent storage (Railway Volume / S3) is the production upgrade.
 */

const TTL_MS = 15 * 60 * 1000; // Twilio fetches within seconds; 15 min is generous.

function storageDir(): string {
  // Prefer an absolute MEDIA_STORAGE_PATH (e.g. a Railway Volume mount). Otherwise
  // use the OS temp dir, which is always writable — avoids permission/cwd issues
  // on the Railway container (relative './storage' may not be writable).
  if (env.MEDIA_STORAGE_PATH && path.isAbsolute(env.MEDIA_STORAGE_PATH)) {
    return env.MEDIA_STORAGE_PATH;
  }
  return path.join(os.tmpdir(), 'wweb-media');
}

function filePath(messageId: string): string {
  // messageId is a cuid (no path separators) — safe to use directly.
  return path.join(storageDir(), messageId);
}

export async function saveMedia(messageId: string, buf: Buffer): Promise<void> {
  await fs.mkdir(storageDir(), { recursive: true });
  await fs.writeFile(filePath(messageId), buf);
}

export async function readMedia(messageId: string): Promise<Buffer> {
  return fs.readFile(filePath(messageId));
}

export async function mediaExists(messageId: string): Promise<boolean> {
  try {
    await fs.access(filePath(messageId));
    return true;
  } catch {
    return false;
  }
}

export function signMediaToken(messageId: string): string {
  const exp = Date.now() + TTL_MS;
  const payload = `${messageId}.${exp}`;
  const sig = crypto.createHmac('sha256', env.SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyMediaToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [messageId, expStr, sig] = parts;
  if (!messageId || !expStr || !sig) return null;
  const expected = crypto
    .createHmac('sha256', env.SESSION_SECRET)
    .update(`${messageId}.${expStr}`)
    .digest('base64url');
  // Constant-time comparison
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(expStr)) return null;
  return messageId;
}

export function mimeToType(mime: string): 'image' | 'video' | 'audio' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}
