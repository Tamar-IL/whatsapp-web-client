import { logger } from '../config/logger';
import { env } from '../config/env';

/**
 * Transcribe audio buffer via Groq Whisper API.
 * Returns the transcript string, or null on failure.
 */
export async function transcribeAudio(buf: Buffer, mime: string): Promise<string | null> {
  if (!env.GROQ_API_KEY) return null;

  const ext = mimeToExt(mime);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), `audio${ext}`);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'he');
  form.append('response_format', 'text');

  try {
    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'groq transcription non-OK');
      return null;
    }
    const text = (await res.text()).trim();
    return text || null;
  } catch (err) {
    logger.error({ err }, 'groq transcription failed');
    return null;
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
    'audio/webm': '.webm',
  };
  return map[base] ?? '.ogg';
}
