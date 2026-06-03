import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { logger } from '../config/logger';

/**
 * Auto-compress outbound video to fit under WhatsApp's hard 16MB media cap
 * (Twilio error 11751 otherwise). This mirrors what the official WhatsApp app
 * does on the sender's device: re-encode to H.264/AAC MP4 at a bitrate sized to
 * land under the limit, scaling resolution down across retries if needed.
 *
 * We bundle the encoder via ffmpeg-static / ffprobe-static so no system ffmpeg
 * install is required (works on the Railway container as-is).
 */

// WhatsApp rejects video > 16MB. Aim under 15MB so we keep a safety margin after
// container overhead, and never bother compressing files already comfortably below.
const HARD_CAP_BYTES = 16 * 1024 * 1024;
const TARGET_BYTES = 15 * 1024 * 1024;
/** Videos at/below this are sent untouched (no quality loss, no CPU cost). */
export const SAFE_VIDEO_BYTES = Math.floor(15.3 * 1024 * 1024);

const AUDIO_BITRATE_K = 128; // AAC stereo — fine for talking/phone video.
const MIN_VIDEO_BITRATE_K = 150; // floor; below this video is unwatchable.

const ffmpegPath = ffmpegStatic as unknown as string | null;
const ffprobePath = (ffprobeStatic as unknown as { path: string }).path;

export interface TranscodeResult {
  buffer: Buffer;
  mime: string;
  filename: string;
}

export class VideoTooLargeError extends Error {
  constructor() {
    super('Video is too long to compress under WhatsApp\'s 16 MB limit.');
    this.name = 'VideoTooLargeError';
  }
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-600)}`));
    });
  });
}

/** Duration in seconds via ffprobe; 0 if it can't be determined. */
async function probeDurationSec(input: string): Promise<number> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        ffprobePath,
        [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          input,
        ],
        { windowsHide: true },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(`ffprobe exited ${code}: ${stderr}`)),
      );
    });
    const dur = parseFloat(out.trim());
    return Number.isFinite(dur) && dur > 0 ? dur : 0;
  } catch {
    return 0;
  }
}

/**
 * Compress `input` until it fits under WhatsApp's 16MB cap.
 * Returns the re-encoded MP4 buffer. Throws VideoTooLargeError if even the
 * lowest-quality pass can't get under the cap (i.e. the clip is simply too long).
 */
export async function compressVideoToFit(
  input: Buffer,
  originalName?: string,
): Promise<TranscodeResult> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg binary not available (ffmpeg-static failed to resolve).');
  }

  const work = path.join(os.tmpdir(), 'wweb-transcode');
  await fs.mkdir(work, { recursive: true });
  const id = crypto.randomUUID();
  const inPath = path.join(work, `${id}.in`);
  const cleanup: string[] = [inPath];
  await fs.writeFile(inPath, input);

  try {
    const duration = await probeDurationSec(inPath);

    // Each attempt targets a smaller size and (later) a smaller frame so we
    // converge under the cap. Resolution caps: 1280 → 960 → 640 → 480.
    const widths = [1280, 960, 640, 480];
    let best: Buffer | null = null;

    for (let attempt = 0; attempt < widths.length; attempt++) {
      const effectiveTarget = TARGET_BYTES * Math.pow(0.82, attempt);

      // Size the video bitrate from the duration budget. Fall back to a fixed
      // guess when duration is unknown (rare; corrupt/streamed inputs).
      let videoBitrateK: number;
      if (duration > 0) {
        const totalK = (effectiveTarget * 8) / duration / 1000;
        videoBitrateK = Math.max(Math.floor(totalK - AUDIO_BITRATE_K), MIN_VIDEO_BITRATE_K);
      } else {
        videoBitrateK = [2000, 1200, 700, 400][attempt]!;
      }

      const width = widths[attempt]!;
      const outPath = path.join(work, `${id}.${attempt}.mp4`);
      cleanup.push(outPath);

      const args = [
        '-y',
        '-i', inPath,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-b:v', `${videoBitrateK}k`,
        '-maxrate', `${videoBitrateK}k`,
        '-bufsize', `${videoBitrateK * 2}k`,
        // Cap width, keep aspect, force even dimensions (H.264 requires even).
        '-vf', `scale='min(${width},iw)':-2`,
        '-c:a', 'aac',
        '-b:a', `${AUDIO_BITRATE_K}k`,
        '-ac', '2',
        '-movflags', '+faststart',
        '-f', 'mp4',
        outPath,
      ];

      logger.info({ attempt, width, videoBitrateK, duration }, 'transcoding video');
      await run(ffmpegPath, args);
      const out = await fs.readFile(outPath);
      best = out;

      logger.info(
        { attempt, outBytes: out.length, capBytes: HARD_CAP_BYTES },
        'transcode attempt result',
      );
      if (out.length <= HARD_CAP_BYTES) {
        const base = (originalName?.replace(/\.[^./\\]+$/, '') || 'video').slice(0, 80);
        return { buffer: out, mime: 'video/mp4', filename: `${base}.mp4` };
      }
    }

    // Even the smallest pass overshot — the clip is too long to fit 16MB.
    logger.warn({ finalBytes: best?.length }, 'video could not be compressed under cap');
    throw new VideoTooLargeError();
  } finally {
    await Promise.all(
      cleanup.map((f) => fs.rm(f, { force: true }).catch(() => undefined)),
    );
  }
}
