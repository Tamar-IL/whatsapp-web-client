import { env } from '../config/env';
import { logger } from '../config/logger';
import { ApiError } from './errors';

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export function mailerConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY);
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}): Promise<void> {
  if (!env.RESEND_API_KEY) {
    throw new ApiError(503, 'MAIL_NOT_CONFIGURED', 'Email is not set up. Add RESEND_API_KEY to the server environment.');
  }

  const from = env.MAIL_FROM ?? 'WhatsApp <onboarding@resend.dev>';

  const body = {
    from,
    to: [opts.to],
    subject: opts.subject,
    text: opts.text,
    attachments: opts.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content.toString('base64'),
    })),
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.error({ status: res.status, detail }, 'resend email failed');
    throw new ApiError(502, 'EMAIL_SEND_FAILED', `Resend error ${res.status}: ${detail}`);
  }

  logger.info({ to: opts.to, subject: opts.subject }, 'email sent via Resend');
}
