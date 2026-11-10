import crypto from 'node:crypto';
import { twilioClient } from './client';
import { prisma } from '../db/prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * WhatsApp quick-reply buttons (Twilio Content API, `twilio/quick-reply`).
 *
 * Unlike edit/delete — which Twilio genuinely cannot do — buttons are real:
 * WhatsApp renders up to three tappable chips under the message, and a tap
 * arrives back on our inbound webhook as ButtonText/ButtonPayload (already
 * decoded in twilio/webhook.ts).
 *
 * THE APPROVAL RULE, because it governs the whole design:
 *   - IN-session (inside the 24h window): a quick-reply Content template can be
 *     sent WITHOUT Meta approval, as long as it is never submitted for approval.
 *     Capped at 3 buttons.
 *   - OUT-of-session: approval required, like any other template.
 * This module only ever serves the in-session path, so it creates templates and
 * deliberately never calls the ApprovalRequests endpoint. Callers must do the
 * window check first (api/messages.ts does).
 *
 * Twilio's Content resources are account-wide and permanent, so creating one per
 * send would quietly fill the account with junk. Each distinct (body + buttons)
 * pair is therefore created once and reused via QuickReplyTemplate, keyed by
 * hash — sending "Yes / No" a hundred times uses one Content resource.
 */

/** WhatsApp caps an unapproved in-session quick-reply at three buttons. */
export const MAX_BUTTONS = 3;
/** Twilio's limit on `twilio/quick-reply` body text. */
export const MAX_BODY_CHARS = 1024;
/** WhatsApp's limit on the text shown on a button. */
export const MAX_BUTTON_CHARS = 20;

export class QuickReplyError extends Error {
  constructor(
    public twilioCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'QuickReplyError';
  }
}

/**
 * Identity of a button message: same text + same labels in the same order.
 *
 * Order is part of the key on purpose — ["Yes","No"] and ["No","Yes"] render
 * differently to the customer, so they are not interchangeable templates.
 */
function templateHash(body: string, buttons: string[]): string {
  return crypto.createHash('sha256').update(JSON.stringify([body, buttons])).digest('hex');
}

/**
 * Get the Content SID for this (body, buttons) pair, creating it on first use.
 *
 * The unique index on `hash` is the real guard against duplicates: two requests
 * racing on the same brand-new button set would both miss the SELECT, so the
 * loser of the INSERT re-reads the winner's row instead of failing. That leaves
 * one orphaned Content resource in Twilio, which is harmless and rare — far
 * better than serving a 500 for a duplicate key.
 */
async function getOrCreateContentSid(body: string, buttons: string[]): Promise<string> {
  const hash = templateHash(body, buttons);

  const existing = await prisma.quickReplyTemplate.findUnique({ where: { hash } });
  if (existing) return existing.contentSid;

  // The SDK's typed contents.create() declares a `contentCreateRequest` wrapper
  // but posts params verbatim, which would put that wrapper on the wire. The
  // documented JSON shape is sent directly instead.
  //
  // NOTE: client.request() resolves on 4xx/5xx rather than throwing (its axios
  // validateStatus accepts every status), so the status is checked by hand —
  // a try/catch alone would treat a rejected template as a success.
  let res: { statusCode: number; body: unknown };
  try {
    res = await twilioClient.request({
      method: 'post',
      uri: 'https://content.twilio.com/v1/Content',
      headers: { 'Content-Type': 'application/json' },
      data: {
        friendly_name: `qr_${hash.slice(0, 16)}`,
        language: env.QUICK_REPLY_LANGUAGE,
        types: {
          'twilio/quick-reply': {
            body,
            // `id` comes back to us as ButtonPayload when tapped. Index-based so
            // it stays stable and short; the visible label is `title`.
            actions: buttons.map((title, i) => ({ title, id: `btn_${i + 1}` })),
          },
        },
      },
    });
  } catch (err) {
    logger.error({ err, buttons }, 'quick-reply content template request failed');
    throw new QuickReplyError(undefined, 'Could not reach Twilio to create the button template.');
  }

  const payload = res.body as { sid?: string; code?: number; message?: string } | null;
  if (res.statusCode >= 300 || !payload?.sid) {
    logger.error(
      { status: res.statusCode, body: res.body, buttons },
      'quick-reply content template creation rejected',
    );
    throw new QuickReplyError(
      payload?.code != null ? String(payload.code) : undefined,
      `Twilio rejected the button template${payload?.message ? `: ${payload.message}` : '.'}`,
    );
  }
  const contentSid = payload.sid;

  try {
    await prisma.quickReplyTemplate.create({ data: { hash, contentSid, body, buttons } });
  } catch {
    // Lost the race — another request created the same template first. Use
    // theirs so both sends succeed and the pairing stays one-to-one.
    const winner = await prisma.quickReplyTemplate.findUnique({ where: { hash } });
    if (winner) return winner.contentSid;
  }

  logger.info({ contentSid, buttons }, 'created quick-reply content template');
  return contentSid;
}

/**
 * Send a text message with quick-reply buttons to a WhatsApp number.
 *
 * Caller must have verified the 24h window is open — see the approval rule above.
 */
export async function sendQuickReply(opts: {
  toPhone: string; // E.164 with leading +
  body: string;
  buttons: string[];
  statusCallbackUrl?: string;
}): Promise<{ sid: string; contentSid: string }> {
  const contentSid = await getOrCreateContentSid(opts.body, opts.buttons);

  try {
    const sent = await twilioClient.messages.create({
      from: env.TWILIO_WHATSAPP_SENDER,
      to: `whatsapp:${opts.toPhone}`,
      contentSid,
      statusCallback: opts.statusCallbackUrl,
    });
    return { sid: sent.sid, contentSid };
  } catch (err) {
    const e = err as { code?: string | number; message?: string };
    logger.error({ err, contentSid }, 'quick-reply send failed');
    throw new QuickReplyError(e.code ? String(e.code) : undefined, e.message ?? 'Send failed');
  }
}
