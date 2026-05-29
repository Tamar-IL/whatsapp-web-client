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

  MEDIA_STORAGE_PATH: z.string().default('./storage'),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),

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
