/**
 * Notification sound for incoming messages.
 *
 * Uses the Web Audio API to synthesise a brief two-note chime — no asset to
 * ship or license. Browsers block audio before the first user interaction;
 * since the user has logged in by the time we call this, playback is allowed.
 */

let ctx: AudioContext | null = null;
let muted = false;

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(c: AudioContext, freq: number, startAt: number, durMs: number, volume = 0.12) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(c.destination);
  const t = c.currentTime + startAt;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + durMs / 1000);
  osc.start(t);
  osc.stop(t + durMs / 1000 + 0.02);
}

/** Brief two-note ding played on a new inbound message. */
export function playMessageDing(): void {
  if (muted) return;
  const c = ensureCtx();
  if (!c) return;
  // ~880Hz (A5) then ~1318Hz (E6) — a friendly "ding" without being shrill.
  tone(c, 880, 0, 180, 0.12);
  tone(c, 1318, 0.11, 220, 0.1);
}

export function setNotificationMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem('wweb.muted', value ? '1' : '0');
  } catch {
    // ignore
  }
}

export function isNotificationMuted(): boolean {
  try {
    return localStorage.getItem('wweb.muted') === '1';
  } catch {
    return false;
  }
}

// Init from localStorage at module load.
muted = isNotificationMuted();
