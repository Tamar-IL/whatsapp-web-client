import { env } from '../config/env';
import { logger } from '../config/logger';
import { prisma } from '../db/prisma';

/**
 * Idempotent bootstrap of the admin user from environment.
 * Called once at startup. Safe to re-run on every deploy.
 *
 * Generate ADMIN_PASSWORD_HASH locally with: npm run hash-password
 */
export async function bootstrapAdminUser(): Promise<void> {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD_HASH) {
    logger.warn(
      'ADMIN_EMAIL / ADMIN_PASSWORD_HASH not set — no bootstrap user will be created. ' +
        'Set both env vars to enable login.',
    );
    return;
  }

  await prisma.user.upsert({
    where: { email: env.ADMIN_EMAIL },
    create: { email: env.ADMIN_EMAIL, passwordHash: env.ADMIN_PASSWORD_HASH },
    update: { passwordHash: env.ADMIN_PASSWORD_HASH },
  });

  logger.info({ email: env.ADMIN_EMAIL }, 'Bootstrap admin user ensured.');
}
