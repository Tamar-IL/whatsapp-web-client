import crypto from 'node:crypto';
import { env } from '../config/env';

/** How long an emailed code stays valid. */
export const LOGIN_CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses allowed on a single code before it is burned. */
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
/** Minimum gap between two codes for the same user (stops inbox flooding). */
export const LOGIN_CODE_RESEND_COOLDOWN_MS = 60_000;

/**
 * Hard caps on how many codes may be issued for the account, whoever asks and
 * from whatever IP. The per-IP rate limiters alone don't bound guessing: an
 * attacker rotating addresses could otherwise get 5 fresh guesses every minute.
 * With these caps the worst case is 10 codes x 5 guesses = 50 guesses a day.
 */
export const LOGIN_CODE_MAX_PER_HOUR = 3;
export const LOGIN_CODE_MAX_PER_DAY = 10;

/** Uniformly random 6-digit code, zero-padded. */
export function generateLoginCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Keyed hash of a code. Bound to the user id so a hash can't be replayed across
 * users, and keyed with SESSION_SECRET so a DB leak alone can't brute-force it.
 */
export function hashLoginCode(userId: string, code: string): string {
  return crypto.createHmac('sha256', env.SESSION_SECRET).update(`${userId}:${code}`).digest('hex');
}

export function loginCodeMatches(userId: string, code: string, storedHash: string): boolean {
  const a = Buffer.from(hashLoginCode(userId, code), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
