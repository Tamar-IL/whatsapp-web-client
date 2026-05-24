import { Pool } from 'pg';
import { env } from '../config/env';

// Shared pg Pool for connect-pg-simple (session store) and pg-boss-compatible callers.
export const pgPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});
