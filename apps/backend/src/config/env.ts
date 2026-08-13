import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  PUBLIC_BASE_URL: z.string().url(),
  FRONTEND_ORIGIN: z.string().url().optional(),
  // Base URL Twilio uses to fetch OUTBOUND media. Should bypass any CDN/proxy
  // (e.g. Cloudflare) that blocks bots — point it at the raw Railway domain.
  // Falls back to RAILWAY_PUBLIC_DOMAIN, then PUBLIC_BASE_URL.
  MEDIA_PUBLIC_BASE_URL: z.string().url().optional(),

  DATABASE_URL: z.string().min(1),

  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET must be at least 16 chars'),
  CSRF_COOKIE_NAME: z.string().default('wweb_csrf'),

  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),

  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_CONVERSATION_SERVICE_SID: z.string().min(1),
  TWILIO_WHATSAPP_SENDER: z.string().regex(/^whatsapp:\+\d+$/, 'TWILIO_WHATSAPP_SENDER must look like "whatsapp:+E.164"'),

  // --- Outgoing email (Zoho SMTP) for "email me this recording" ---
  // Sending uses SMTP, NOT IMAP (IMAP only reads mailboxes). For Zoho:
  //   SMTP_HOST=smtp.zoho.com  SMTP_PORT=465  SMTP_USER=you@yourdomain
  //   SMTP_PASS=<app-specific password>   (generate one in Zoho if 2FA is on)
  // SMTP is the primary transport: when SMTP_USER + SMTP_PASS are both set it is
  // used and RESEND_API_KEY is ignored. Zoho EU accounts use smtp.zoho.eu.
  SMTP_HOST: z.string().default('smtp.zoho.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  // Leave unset to auto-pick: true for port 465, false otherwise (e.g. 587/STARTTLS).
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // Defaults to SMTP_USER when omitted.
  MAIL_FROM: z.string().optional(),
  // Where "email me this recording" delivers to.
  MEDIA_EMAIL_TO: z.string().email().default('swenlly123@gmail.com'),

  // Make.com webhook URL for forwarding inbound media (bypasses NetFree).
  // Leave unset to disable.
  MAKE_WEBHOOK_URL: z.string().url().optional(),

  // Groq API key for Whisper audio transcription. Leave unset to disable.
  GROQ_API_KEY: z.string().optional(),

  // Fallback transport for hosts that block outbound SMTP ports (Railway did).
  // Only used when SMTP_USER/SMTP_PASS are absent — SMTP wins when both are set.
  RESEND_API_KEY: z.string().optional(),

  MEDIA_STORAGE_PATH: z.string().default('./storage'),
  // Max upload accepted into the server. Source videos are auto-compressed down
  // to fit WhatsApp's 16MB cap, so this is the cap on the ORIGINAL file the
  // operator picks (not what WhatsApp receives). Kept generous for phone clips.
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(200 * 1024 * 1024),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: z.string().default('1'),
});

export type AppEnv = z.infer<typeof schema>;

function load(): AppEnv {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';
