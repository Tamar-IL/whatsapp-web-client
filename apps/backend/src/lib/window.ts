/**
 * 24-hour window helper (§7.3 of the spec, deep-dive §6).
 *
 * Free-form WhatsApp messages can only be sent within 24 hours of the customer's
 * last inbound message. If no inbound has ever arrived, the window is considered
 * closed and a template message is required.
 */

export interface WindowState {
  open: boolean;
  closesAt: Date | null;
  remainingMs: number;
}

export function windowState(lastInboundAt: Date | null, now: Date = new Date()): WindowState {
  if (!lastInboundAt) return { open: false, closesAt: null, remainingMs: 0 };
  const closesAt = new Date(lastInboundAt.getTime() + 24 * 3600 * 1000);
  const remainingMs = closesAt.getTime() - now.getTime();
  return { open: remainingMs > 0, closesAt, remainingMs: Math.max(0, remainingMs) };
}

export class WindowClosedError extends Error {
  code = 'WINDOW_CLOSED' as const;
  constructor() {
    super('Free-form messaging is not available outside the 24-hour window. Use a template message.');
  }
}
