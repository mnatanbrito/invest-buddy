import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { DEFAULT_CONNECTION_STRING, createPool } from '../db/pool';

const SQL_DIR = path.resolve(import.meta.dirname, '../db');

const schemaSql = readFileSync(path.join(SQL_DIR, 'schema.sql'), 'utf8');
const seedSql = readFileSync(path.join(SQL_DIR, 'seed.sql'), 'utf8');

const baseUrl = () => process.env.DATABASE_URL ?? DEFAULT_CONNECTION_STRING;

/** Same server, different database name. */
function urlForDatabase(name: string): string {
  const url = new URL(baseUrl());
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Connects to the `postgres` maintenance database, which is the only way to issue
 * CREATE/DROP DATABASE. Doing this over `pg` rather than shelling out to createdb
 * keeps the tests independent of whether Homebrew's keg-only binaries are on PATH.
 */
async function withAdmin<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const admin = new Pool({ connectionString: urlForDatabase('postgres') });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

let counter = 0;

export interface TestDatabase {
  pool: Pool;
  name: string;
  /** Truncate the ledger and restore seeded values, without paying to recreate the database. */
  reset: () => Promise<void>;
  drop: () => Promise<void>;
}

/**
 * Builds a throwaway database seeded from the real schema.sql and seed.sql, so the
 * tests exercise the same DDL the app ships rather than a hand-maintained copy.
 *
 * Each call gets its own database, keyed by pid and a counter, so parallel test
 * files never share state.
 */
export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const safeLabel = label.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const name = `invest_buddy_test_${safeLabel}_${process.pid}_${counter++}`;

  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  });

  const pool = createPool(urlForDatabase(name));
  await pool.query(schemaSql);
  await pool.query(seedSql);

  return {
    pool,
    name,
    reset: async () => {
      // schema.sql drops and recreates every table, so this also clears the ledger.
      await pool.query(schemaSql);
      await pool.query(seedSql);
    },
    drop: async () => {
      await pool.end();
      await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS "${name}"`));
    },
  };
}
