import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { ApiError } from './errors';

/**
 * Outgoing email via SMTP (Zoho).
 *
 * Used by the "email me this recording" action: the SERVER fetches the media and
 * mails it as an attachment, so the bytes never travel through the operator's
 * (NetFree-filtered) browser. That's the whole point — a direct download gets
 * swapped for a NetFree block page, but an email attachment sidesteps it.
 *
 * Sending requires SMTP credentials (NOT IMAP — IMAP only reads mail). Until
 * SMTP_USER + SMTP_PASS are set the feature returns a clear 503 instead of
 * silently doing nothing.
 */

let transporter: Transporter | null = null;

export function mailerConfigured(): boolean {
  return Boolean(env.SMTP_USER && env.SMTP_PASS);
}

function getTransporter(): Transporter {
  if (!mailerConfigured()) {
    throw new ApiError(
      503,
      'MAIL_NOT_CONFIGURED',
      'Email is not set up yet. Add Zoho SMTP_USER and SMTP_PASS to the server environment.',
    );
  }
  if (!transporter) {
    // Auto-pick TLS mode from the port unless explicitly overridden.
    const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : env.SMTP_PORT === 465;
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure,
      auth: { user: env.SMTP_USER!, pass: env.SMTP_PASS! },
    });
  }
  return transporter;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}): Promise<void> {
  const t = getTransporter();
  const from = env.MAIL_FROM || env.SMTP_USER!;
  await t.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    attachments: opts.attachments,
  });
  logger.info({ to: opts.to, subject: opts.subject }, 'media email sent');
}
