import { defineConfig } from 'drizzle-kit';

/**
 * The fallback URL duplicates `DEFAULT_CONNECTION_STRING` in `server/db/pool.ts`
 * on purpose: drizzle-kit loads this file in isolation and importing the pool
 * module here would drag `pg` and its side effects into the CLI's bundle.
 */
const DEFAULT_URL = 'postgresql://localhost:5432/invest_buddy';

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? DEFAULT_URL },
  strict: true,
  verbose: true,
});
