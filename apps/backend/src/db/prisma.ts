import { PrismaClient } from '@prisma/client';
import { isProd } from '../config/env';

declare global {
  // Avoid creating multiple clients during dev hot-reload
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__prisma ?? new PrismaClient({ log: isProd ? ['error'] : ['warn', 'error'] });

if (!isProd) global.__prisma = prisma;
