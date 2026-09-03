import path from 'node:path';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  DEFAULT_CONNECTION_STRING,
  createDb,
  createPool,
  withTransaction,
  type Database,
} from '../db/pool';
import { EXAMPLE_PORTFOLIO, insertPortfolio } from '../presets/example';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../db/migrations');

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
  /** Drizzle instance bound to the same throwaway pool. */
  orm: Database;
  name: string;
  /** Truncate the ledger and restore seeded values, without paying to recreate the database. */
  reset: () => Promise<void>;
  drop: () => Promise<void>;
}

/**
 * Builds a throwaway database by running the generated Drizzle migrations, so the
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
  const orm = createDb(pool);
  await migrate(orm, { migrationsFolder: MIGRATIONS_DIR });

  return {
    pool,
    orm,
    name,
    reset: async () => {
      // TRUNCATE ... RESTART IDENTITY resets the SERIAL sequences too, so
      // investment ids start at 1 in every test the same way the old
      // drop-and-recreate did.
      await pool.query(
        'TRUNCATE accounts, sleeves, assets, investments, investment_lines RESTART IDENTITY CASCADE',
      );
    },
    drop: async () => {
      await pool.end();
      await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS "${name}"`));
    },
  };
}

/** Loads the example account/sleeve/asset tree into an (assumed empty) test database. */
export async function loadExample(pool: Pool): Promise<void> {
  await withTransaction(pool, (client) => insertPortfolio(client, EXAMPLE_PORTFOLIO));
}
