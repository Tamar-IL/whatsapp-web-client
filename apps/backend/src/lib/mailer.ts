import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { ApiError } from './errors';

/**
 * Outgoing email for the "email me this recording" action: the SERVER fetches
 * the media and mails it as an attachment, so the bytes never travel through
 * the operator's (NetFree-filtered) browser.
 *
 * Two transports, picked in this order:
 *   1. SMTP (Zoho) — used whenever SMTP_USER + SMTP_PASS are set. Works on the
 *      self-hosted Hetzner box; Zoho wants port 465 (implicit TLS) or 587.
 *   2. Resend HTTP API — fallback for hosts that block outbound SMTP ports
 *      (Railway did). Only used when SMTP is not configured.
 * With neither configured the feature returns a clear 503.
 *
 * Note SMTP needs an *app-specific password* when the Zoho account has 2FA on,
 * and it is SMTP, not IMAP (IMAP only reads mailboxes).
 */

let transporter: Transporter | null = null;

function smtpConfigured(): boolean {
  return Boolean(env.SMTP_USER && env.SMTP_PASS);
}

export function mailerConfigured(): boolean {
  return smtpConfigured() || Boolean(env.RESEND_API_KEY);
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

function getTransporter(): Transporter {
  if (!transporter) {
    // Auto-pick TLS mode from the port unless explicitly overridden.
    const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : env.SMTP_PORT === 465;
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure,
      auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
      // Fail fast instead of hanging forever if the host blocks outbound SMTP.
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  }
  return transporter;
}

async function sendViaSmtp(opts: {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}): Promise<void> {
  const from = env.MAIL_FROM || env.SMTP_USER!;
  await getTransporter().sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    attachments: opts.attachments,
  });
  logger.info({ to: opts.to, subject: opts.subject }, 'email sent via SMTP');
}

async function sendViaResend(opts: {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}): Promise<void> {
  const from = env.MAIL_FROM ?? 'WhatsApp <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      attachments: opts.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content.toString('base64'),
      })),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.error({ status: res.status, detail }, 'resend email failed');
    throw new ApiError(502, 'EMAIL_SEND_FAILED', `Resend error ${res.status}: ${detail}`);
  }

  logger.info({ to: opts.to, subject: opts.subject }, 'email sent via Resend');
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}): Promise<void> {
  if (smtpConfigured()) return sendViaSmtp(opts);
  if (env.RESEND_API_KEY) return sendViaResend(opts);
  throw new ApiError(
    503,
    'MAIL_NOT_CONFIGURED',
    'Email is not set up. Add SMTP_USER and SMTP_PASS (Zoho) to the server environment.',
  );
}
