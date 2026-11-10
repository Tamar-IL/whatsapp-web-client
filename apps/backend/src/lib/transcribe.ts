import { logger } from '../config/logger';
import { env } from '../config/env';

export type TranscribeResult = { ok: true; text: string } | { ok: false; reason: string };

/** True when a Groq key is configured (whitespace-only counts as missing). */
export function transcriptionEnabled(): boolean {
  return Boolean(env.GROQ_API_KEY?.trim());
}

/**
 * Transcribe audio via the Groq Whisper API.
 *
 * Never throws: failures come back as `{ ok: false, reason }` with a readable
 * reason (missing key, Groq's own error message, timeout, ...) so callers can
 * log it and show it to the operator instead of failing silently.
 */
export async function transcribeAudioDetailed(buf: Buffer, mime: string): Promise<TranscribeResult> {
  // Trim: a key pasted into .env with a trailing space / CR (Windows editor)
  // makes Groq answer 401 "Invalid API Key" even though the key "is there".
  const key = env.GROQ_API_KEY?.trim().replace(/^["']|["']$/g, '');
  if (!key) return { ok: false, reason: 'GROQ_API_KEY is not set on the server' };
  if (!buf.length) return { ok: false, reason: 'audio file is empty' };

  const baseMime = (mime.split(';')[0] ?? mime).trim() || 'audio/ogg';
  const ext = mimeToExt(baseMime);
  const form = new FormData();
  // Send the bare MIME: "audio/ogg; codecs=opus" (what WhatsApp voice notes
  // report) is not something every upstream parser accepts.
  form.append('file', new Blob([buf], { type: baseMime }), `audio${ext}`);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'he');
  form.append('response_format', 'text');

  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      let detail = raw;
      try {
        detail = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? raw;
      } catch {
        /* not JSON — keep raw text */
      }
      const reason = `Groq returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`;
      logger.warn({ status: res.status, detail: raw.slice(0, 1000), mime, bytes: buf.length }, 'groq transcription non-OK');
      return { ok: false, reason };
    }
    const text = (await res.text()).trim();
    if (!text) return { ok: false, reason: 'no speech was recognised in the recording' };
    logger.info({ bytes: buf.length, chars: text.length }, 'audio transcribed');
    return { ok: true, text };
  } catch (err) {
    logger.error({ err }, 'groq transcription failed');
    const name = (err as Error)?.name;
    const reason =
      name === 'TimeoutError'
        ? 'timed out waiting for Groq'
        : `could not reach Groq (${(err as Error)?.message ?? 'network error'})`;
    return { ok: false, reason };
  }
}

/** Backwards-compatible wrapper: transcript string, or null on any failure. */
export async function transcribeAudio(buf: Buffer, mime: string): Promise<string | null> {
  const r = await transcribeAudioDetailed(buf, mime);
  return r.ok ? r.text : null;
}

function mimeToExt(mime: string): string {
  const base = (mime.split(';')[0] ?? mime).trim();
  const map: Record<string, string> = {
    'audio/ogg': '.ogg',
    'audio/opus': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/aac': '.aac',
    'audio/amr': '.amr',
    'audio/webm': '.webm',
  };
  return map[base] ?? '.ogg';
}
