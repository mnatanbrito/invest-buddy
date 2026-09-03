import path from 'node:path';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { DEFAULT_CONNECTION_STRING, createDb, createPool } from './pool';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, 'migrations');
const targetUrl = process.env.DATABASE_URL ?? DEFAULT_CONNECTION_STRING;
const dbName = new URL(targetUrl).pathname.replace(/^\//, '') || 'invest_buddy';
if (dbName === 'postgres') {
  throw new Error(
    'refusing to reset the "postgres" maintenance database — set DATABASE_URL to a real target',
  );
}

/** Same server, different database name — used to reach the `postgres` maintenance DB. */
function urlForDatabase(name: string): string {
  const url = new URL(targetUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const admin = new Pool({ connectionString: urlForDatabase('postgres') });
try {
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
} finally {
  await admin.end();
}

const pool = createPool(targetUrl);
try {
  await migrate(createDb(pool), { migrationsFolder: MIGRATIONS_DIR });
} finally {
  await pool.end();
}

console.log(`db:reset — "${dbName}" dropped, recreated, and migrated.`);
