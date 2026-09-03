# ORM + Migration Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written SQL + `schema.sql` setup with Drizzle ORM and drizzle-kit migrations, converting the straightforward queries while keeping the deliberately hand-tuned SQL.

**Architecture:** `server/db/schema.ts` becomes the single source of truth for the database shape; drizzle-kit generates versioned SQL migration files from it. A `createDb(pool)` helper wraps the existing `pg` Pool in a typed Drizzle instance that flows through `createApp`, `portfolio.ts`, and `presets/example.ts`. The per-file throwaway test databases are built by running the generated migrations through Drizzle's migrator and wiped with `TRUNCATE`. `LOCK TABLE` statements, the `/api/undo` correlated update, and the `/api/history` `json_agg` aggregation stay as raw SQL executed on the Drizzle handle.

**Tech Stack:** TypeScript (ESM), Node 20, pnpm, Express 5, `pg`, Drizzle ORM (`drizzle-orm`), drizzle-kit, Zod, Vitest + supertest, PostgreSQL 18.

**Spec:** `docs/superpowers/specs/2026-09-03-orm-migration-integration-design.md`

## Global Constraints

- **Runtime:** Node `20+` (CI pins `20`); pnpm `10.19.0` (`packageManager` field). ESM only (`"type": "module"`).
- **Gates that must stay green:** `pnpm lint` (`oxlint --deny-warnings` — any warning fails), `pnpm typecheck` (`tsc -b --noEmit && tsc -p tsconfig.server.json`, both with `noUnusedLocals`/`noUnusedParameters`), `pnpm test` (Vitest, needs local PostgreSQL), `pnpm build`.
- **`main` is pull-request-only** — a repository ruleset blocks direct pushes and holds merge until the `ci` workflow is green, for everyone including the owner. Do all work on the `orm-migration-integration` branch. Do not push without the user's explicit go-ahead.
- **Money is integer cents everywhere**, stored as `BIGINT`. `target_bps` / `weight_bps` are basis points (`0..10000`).
- **Faithful 1:1 schema port** — this change introduces no schema changes: same tables, columns, types, defaults, CHECK constraints, foreign-key delete behaviour, uniques, and indexes as `server/db/schema.sql` today. Auto-generated constraint *names* may differ (documented per task); structure may not.
- **Keep the global `pg.types.setTypeParser(INT8, Number)`** in `server/db/pool.ts` — several derived values (`SUM(...)::BIGINT`) rely on it to arrive as numbers.
- **DB connection:** base URL from `process.env.DATABASE_URL`, falling back to `DEFAULT_CONNECTION_STRING` (`postgresql://localhost:5432/invest_buddy`). Test/reset code swaps only the database name on that base URL.

---

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `drizzle.config.ts` | create | drizzle-kit config: dialect, schema path, migrations output dir, credentials |
| `server/db/schema.ts` | create | Drizzle table definitions — single source of truth for the DB shape |
| `server/db/migrations/` | create | Generated SQL migration files + `meta/` snapshots (committed) |
| `server/db/reset.ts` | create | `pnpm db:reset` script: drop + recreate the local DB, then run the migrator |
| `server/db/schema.test.ts` | create | Introspection test locking down the 1:1 port (constraints, FK actions, indexes) |
| `server/db/schema.sql` | delete | Replaced by `server/db/migrations/0000_*.sql` |
| `server/db/pool.ts` | modify | Add `createDb` + `Database`/`Transaction`/`Executor` types; remove `withTransaction` (Task 4) |
| `server/test/db.ts` | modify | Build test DBs via the migrator; `reset()` via `TRUNCATE`; expose `orm` |
| `server/portfolio.ts` | modify | `readPortfolio` / `deleteBlockers` / `nextSortOrder` / `resequence` take an `Executor`; drop `*Row` interfaces |
| `server/presets/example.ts` | modify | `insertPortfolio` takes an `Executor`, uses the query builder |
| `server/app.ts` | modify | `createApp(db)`; convert the straightforward queries; keep `LOCK`/undo/history raw; delete `buildUpdate` |
| `server/index.ts` | modify | `createApp(createDb(createPool()))` |
| `server/api.test.ts` | modify | Construct against `db.orm` |
| `server/portfolio.test.ts` | modify | Call the helpers with `db.orm` |
| `package.json` | modify | Add `db:generate` / `db:migrate` / `db:check`; repoint `db:reset` |
| `tsconfig.node.json` | modify | Add `drizzle.config.ts` to `include` |
| `.github/workflows/ci.yml` | modify | Run `pnpm db:check` before `pnpm test` |
| `README.md` | modify | Setup, psql section, resetting, scripts table, tests section, layout, "Changing the schema" |

---

## Task 1: Stand up Drizzle — deps, config, schema, initial migration

**Files:**
- Modify: `package.json` (scripts + deps)
- Modify: `tsconfig.node.json`
- Create: `drizzle.config.ts`
- Create: `server/db/schema.ts`
- Create: `server/db/migrations/0000_*.sql` + `server/db/migrations/meta/*` (generated)

**Interfaces:**
- Produces: `server/db/schema.ts` exporting `accounts`, `sleeves`, `assets`, `investments`, `investmentLines` (Drizzle `pgTable` objects). Column-name → property-name map: `room_limit`→`roomLimit`, `account_id`→`accountId`, `target_bps`→`targetBps`, `sleeve_id`→`sleeveId`, `weight_bps`→`weightBps`, `holding_cents`→`holdingCents`, `sort_order`→`sortOrder`, `requested_cents`→`requestedCents`, `allocated_cents`→`allocatedCents`, `unallocated_cents`→`unallocatedCents`, `created_at`→`createdAt`, `investment_id`→`investmentId`, `asset_id`→`assetId`, `intended_cents`→`intendedCents`, `amount_cents`→`amountCents`. All other columns keep their name.

- [ ] **Step 1: Install dependencies**

```bash
pnpm add drizzle-orm
pnpm add -D drizzle-kit
```

Expected: `drizzle-orm` in `dependencies`, `drizzle-kit` in `devDependencies`, lockfile updated. `esbuild` (drizzle-kit's bundler) is already in `pnpm.onlyBuiltDependencies`, so no approve-builds prompt.

- [ ] **Step 2: Add the migration scripts to `package.json`**

Add these entries to `"scripts"` (leave `db:reset` untouched in this task):

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:check": "drizzle-kit check",
```

- [ ] **Step 3: Add `drizzle.config.ts` to the node tsconfig**

In `tsconfig.node.json`, change the `include` array from `["vite.config.ts"]` to:

```json
"include": ["vite.config.ts", "drizzle.config.ts"]
```

- [ ] **Step 4: Create `drizzle.config.ts`**

```ts
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
```

- [ ] **Step 5: Create `server/db/schema.ts`**

Port `server/db/schema.sql` exactly. Read `server/db/schema.sql` alongside this and confirm every column, default, CHECK, FK, unique, and index below matches it.

```ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    note: text('note').notNull().default(''),
    // Total CRA contribution room, in cents. NULL means "no limit" (non-registered).
    roomLimit: bigint('room_limit', { mode: 'number' }),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [
    check('account_label_present', sql`btrim(${t.label}) <> ''`),
    check('room_limit_non_negative', sql`${t.roomLimit} IS NULL OR ${t.roomLimit} >= 0`),
  ],
);

export const sleeves = pgTable(
  'sleeves',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    // Target weight as a fraction of the TOTAL portfolio, in basis points.
    targetBps: integer('target_bps').notNull(),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [
    index('sleeves_account_idx').on(t.accountId),
    check('sleeve_label_present', sql`btrim(${t.label}) <> ''`),
    check('target_bps_valid', sql`${t.targetBps} BETWEEN 0 AND 10000`),
  ],
);

export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    sleeveId: text('sleeve_id')
      .notNull()
      .references(() => sleeves.id, { onDelete: 'cascade' }),
    ticker: text('ticker').notNull(),
    label: text('label').notNull().default(''),
    // Target weight as a fraction of the PARENT SLEEVE, in basis points.
    weightBps: integer('weight_bps').notNull(),
    // Current book value of this asset, in cents. The only stored holding figure.
    holdingCents: bigint('holding_cents', { mode: 'number' }).notNull().default(0),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [
    index('assets_sleeve_idx').on(t.sleeveId),
    unique('asset_ticker_unique_in_sleeve').on(t.sleeveId, t.ticker),
    check('asset_ticker_present', sql`btrim(${t.ticker}) <> ''`),
    check('weight_bps_valid', sql`${t.weightBps} BETWEEN 0 AND 10000`),
    check('holding_non_negative', sql`${t.holdingCents} >= 0`),
  ],
);

export const investments = pgTable(
  'investments',
  {
    id: serial('id').primaryKey(),
    label: text('label').notNull().default(''),
    requestedCents: bigint('requested_cents', { mode: 'number' }).notNull(),
    allocatedCents: bigint('allocated_cents', { mode: 'number' }).notNull(),
    unallocatedCents: bigint('unallocated_cents', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('requested_positive', sql`${t.requestedCents} > 0`),
    check(
      'allocation_balances',
      sql`${t.allocatedCents} + ${t.unallocatedCents} = ${t.requestedCents}`,
    ),
  ],
);

export const investmentLines = pgTable(
  'investment_lines',
  {
    id: serial('id').primaryKey(),
    investmentId: integer('investment_id')
      .notNull()
      .references(() => investments.id, { onDelete: 'cascade' }),
    // No onDelete here: an asset that ever appears in investment history can never
    // be deleted (Postgres NO ACTION / RESTRICT). The app-level delete-blocker check
    // only exists to turn the resulting FK violation into a clean 409.
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id),
    intendedCents: bigint('intended_cents', { mode: 'number' }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('investment_lines_investment_idx').on(t.investmentId),
    index('investment_lines_asset_idx').on(t.assetId),
    unique('investment_lines_investment_id_asset_id_key').on(t.investmentId, t.assetId),
    check(
      'amounts_non_negative',
      sql`${t.amountCents} >= 0 AND ${t.intendedCents} >= ${t.amountCents}`,
    ),
  ],
);
```

Note: if drizzle-kit rejects the array form of the third argument, switch each `(t) => [ ... ]` to `(t) => ({ ...named })` (object form) — same constraints, keyed by a short name.

- [ ] **Step 5b: Lint + typecheck the new files**

Run: `pnpm lint && pnpm typecheck`
Expected: PASS. Fix any unused-import or type errors in `schema.ts` before continuing.

- [ ] **Step 6: Generate the initial migration**

```bash
pnpm db:generate
```

Expected: a new `server/db/migrations/0000_<random-name>.sql` plus `server/db/migrations/meta/0000_snapshot.json` and `server/db/migrations/meta/_journal.json`. Open the `.sql` file and read it top to bottom.

- [ ] **Step 7: Verify the migration matches `schema.sql` structurally**

```bash
createdb ib_from_sql && psql -q -d ib_from_sql -v ON_ERROR_STOP=1 -f server/db/schema.sql
createdb ib_from_migration && psql -q -d ib_from_migration -v ON_ERROR_STOP=1 -f server/db/migrations/0000_*.sql
pg_dump --schema-only --no-owner --no-privileges ib_from_sql > /tmp/from_sql.sql
pg_dump --schema-only --no-owner --no-privileges ib_from_migration > /tmp/from_migration.sql
diff -u /tmp/from_sql.sql /tmp/from_migration.sql || true
dropdb ib_from_sql && dropdb ib_from_migration
```

Expected diffs (acceptable): constraint / index auto-name spelling, statement ordering, whitespace. **Not acceptable** — a missing or changed CHECK, a column with a different type or default, a foreign key with a different `ON DELETE`, a missing index or unique. If any structural diff appears, fix `schema.ts`, re-run `pnpm db:generate` (delete the stale `0000_*` files and `meta/` first), and repeat.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.node.json drizzle.config.ts server/db/schema.ts server/db/migrations
git commit -m "Add Drizzle schema, config, and initial migration (#11)"
```

---

## Task 2: Rebuild the test harness on the migrator

**Files:**
- Modify: `server/db/pool.ts`
- Modify: `server/test/db.ts`
- Create: `server/db/schema.test.ts`
- Test: `server/db/schema.test.ts`, plus the existing `server/portfolio.test.ts` / `server/api.test.ts` must still pass unchanged.

**Interfaces:**
- Consumes: `accounts`, `sleeves`, `assets`, `investments`, `investmentLines` from `server/db/schema.ts` (Task 1).
- Produces:
  - `server/db/pool.ts` → `createDb(pool: Pool): Database`; types `Database` (= `NodePgDatabase<typeof schema>`), `Transaction`, `Executor` (= `Database | Transaction`). `createPool`, `withTransaction`, `DEFAULT_CONNECTION_STRING` unchanged.
  - `server/test/db.ts` → `TestDatabase` now also has `orm: Database`. `createTestDatabase(label: string): Promise<TestDatabase>` and `loadExample(pool: Pool): Promise<void>` keep their existing call signatures for now.

- [ ] **Step 1: Add `createDb` and the executor types to `server/db/pool.ts`**

Add imports at the top (after the existing `import pg, { Pool, type PoolClient } from 'pg';`):

```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
```

Add, after `createPool`:

```ts
/** A Drizzle instance bound to `pool`. Reuses the same connections and type parsers. */
export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}

export type Database = NodePgDatabase<typeof schema>;
/** The handle Drizzle hands to a `db.transaction(...)` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Anything you can run queries on — the pool-bound db or an open transaction. */
export type Executor = Database | Transaction;
```

Run: `pnpm typecheck`
Expected: PASS. If TypeScript rejects `Database | Transaction` as a callable union at a later use site, fall back to `export type Executor = Database;` and pass transaction handles as `tx as Database` — note this in the task's completion notes.

- [ ] **Step 2: Rewrite `server/test/db.ts` to build via the migrator**

Replace the file's schema-loading mechanism. Concretely:

Change the imports block to:

```ts
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
```

Delete the `readFileSync` / `SQL_DIR` / `schemaSql` lines.

In the `TestDatabase` interface, add:

```ts
  /** Drizzle instance bound to the same throwaway pool. */
  orm: Database;
```

In `createTestDatabase`, replace `const pool = createPool(urlForDatabase(name)); await pool.query(schemaSql);` with:

```ts
  const pool = createPool(urlForDatabase(name));
  const orm = createDb(pool);
  await migrate(orm, { migrationsFolder: MIGRATIONS_DIR });
```

Return `orm` alongside `pool` in the returned object.

Replace the `reset` implementation with a `TRUNCATE`:

```ts
    reset: async () => {
      // TRUNCATE ... RESTART IDENTITY resets the SERIAL sequences too, so
      // investment ids start at 1 in every test the same way the old
      // drop-and-recreate did.
      await pool.query(
        'TRUNCATE accounts, sleeves, assets, investments, investment_lines RESTART IDENTITY CASCADE',
      );
    },
```

Leave `loadExample(pool: Pool)` as it is (still `withTransaction(pool, (client) => insertPortfolio(client, EXAMPLE_PORTFOLIO))`).

- [ ] **Step 3: Run the existing DB-backed suites**

Run: `pnpm test -- server/portfolio.test.ts server/api.test.ts`
Expected: PASS (unchanged). If `TRUNCATE` fails with "cannot truncate a table referenced in a foreign key constraint", confirm `CASCADE` is present. If a test that asserts a specific `investments.id` fails, confirm `RESTART IDENTITY` is present.

- [ ] **Step 4: Write `server/db/schema.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('schema');
});

afterAll(async () => {
  await db.drop();
});

describe('schema built from the generated migrations', () => {
  it('creates the five tables', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'accounts',
      'assets',
      'investment_lines',
      'investments',
      'sleeves',
    ]);
  });

  it('carries every named CHECK constraint', async () => {
    const { rows } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE contype = 'c' ORDER BY conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual(
      expect.arrayContaining([
        'account_label_present',
        'allocation_balances',
        'amounts_non_negative',
        'asset_ticker_present',
        'holding_non_negative',
        'requested_positive',
        'room_limit_non_negative',
        'sleeve_label_present',
        'target_bps_valid',
        'weight_bps_valid',
      ]),
    );
  });

  it('keeps investment_lines.asset_id non-cascading while the rest cascade', async () => {
    const { rows } = await db.pool.query<{
      conname: string;
      confdeltype: string;
      conrelid: string;
      table_name: string;
    }>(
      `SELECT c.conname, c.confdeltype, r.relname AS table_name
         FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
        WHERE c.contype = 'f'`,
    );
    const assetFk = rows.find(
      (r) => r.table_name === 'investment_lines' && r.conname.includes('asset_id'),
    );
    // 'a' = NO ACTION, 'c' = CASCADE
    expect(assetFk?.confdeltype).toBe('a');
    for (const r of rows.filter((r) => r !== assetFk)) {
      expect(r.confdeltype, r.conname).toBe('c');
    }
  });

  it('carries the composite uniques and the explicit indexes', async () => {
    const { rows } = await db.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'sleeves_account_idx',
        'assets_sleeve_idx',
        'investment_lines_investment_idx',
        'investment_lines_asset_idx',
        'asset_ticker_unique_in_sleeve',
      ]),
    );
  });
});
```

- [ ] **Step 5: Run the new test**

Run: `pnpm test -- server/db/schema.test.ts`
Expected: PASS. If the FK-name check misfires (the anonymous asset FK may be named `investment_lines_asset_id_assets_id_fk` by Drizzle), adjust the `.includes('asset_id')` match to whatever `pg_constraint` actually reports for that row.

- [ ] **Step 6: Full suite + gates**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/db/pool.ts server/test/db.ts server/db/schema.test.ts
git commit -m "Build test databases from the Drizzle migrator (#11)"
```

---

## Task 3: Replace `db:reset`, delete `schema.sql`

**Files:**
- Create: `server/db/reset.ts`
- Modify: `package.json`
- Delete: `server/db/schema.sql`
- Modify: `server/test/db.ts` (comment only)

**Interfaces:**
- Consumes: `createDb`, `createPool`, `DEFAULT_CONNECTION_STRING` from `server/db/pool.ts`; `server/db/migrations/`.
- Produces: `pnpm db:reset` recreates the target database and applies all migrations.

- [ ] **Step 1: Create `server/db/reset.ts`**

```ts
import path from 'node:path';
import { Pool } from 'pg';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { DEFAULT_CONNECTION_STRING, createDb, createPool } from './pool';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, 'migrations');
const targetUrl = process.env.DATABASE_URL ?? DEFAULT_CONNECTION_STRING;
const dbName = new URL(targetUrl).pathname.replace(/^\//, '') || 'invest_buddy';

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
```

- [ ] **Step 2: Repoint the `db:reset` script**

In `package.json`, change:

```json
"db:reset": "psql -d invest_buddy -v ON_ERROR_STOP=1 -f server/db/schema.sql",
```

to:

```json
"db:reset": "tsx server/db/reset.ts",
```

- [ ] **Step 3: Delete `server/db/schema.sql`**

```bash
git rm server/db/schema.sql
```

- [ ] **Step 4: Fix the stale comment in `server/test/db.ts`**

Find the doc comment above `createTestDatabase` that says it builds "from the real schema.sql and seed.sql" and replace it with:

```ts
/**
 * Builds a throwaway database and brings it up to date by running the generated
 * Drizzle migrations, so the tests exercise the same migration chain the app ships.
 *
 * Each call gets its own database, keyed by pid and a counter, so parallel test
 * files never share state.
 */
```

Also fix the `reset` comment if it still mentions `schema.sql`.

- [ ] **Step 5: Verify `pnpm db:reset` against a real local database**

```bash
pnpm db:reset
psql -d invest_buddy -c '\dt'
psql -d invest_buddy -c '\d assets'
psql -d invest_buddy -c 'SELECT count(*) FROM accounts;'
```

Expected: five tables listed; `\d assets` shows the CHECK constraints and the `assets_sleeve_idx` / `asset_ticker_unique_in_sleeve` indexes; `accounts` count is `0`. Run `pnpm db:reset` a second time to confirm the `DROP DATABASE ... WITH (FORCE)` path works when the DB already exists.

- [ ] **Step 6: Gates**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json server/db/reset.ts server/test/db.ts
git commit -m "Replace db:reset with a migrator-driven script; drop schema.sql (#11)"
```

---

## Task 4: Move the data layer to Drizzle

This is the core conversion: `portfolio.ts`, `presets/example.ts`, `app.ts`, `index.ts`, and the two DB-backed test files change together because they share the `Executor` contract and every write route ends by calling `readPortfolio`. Apply the steps in order. The server suite will not compile between Step 3 and Step 13 — that is expected; the gate is at Step 14.

**Files:**
- Modify: `server/portfolio.ts`, `server/presets/example.ts`, `server/app.ts`, `server/index.ts`, `server/db/pool.ts`
- Modify: `server/api.test.ts`, `server/portfolio.test.ts`

**Interfaces:**
- Consumes: `Executor`, `Database`, `Transaction`, `createDb`, `createPool` from `server/db/pool.ts`; the table objects from `server/db/schema.ts`.
- Produces:
  - `server/portfolio.ts` → `readPortfolio(exec: Executor): Promise<PortfolioState>`; `deleteBlockers(exec: Executor, kind: EntityKind, id: string): Promise<DeleteBlock>`; `nextSortOrder(exec: Executor, table: SortableTable, parentId: string | null): Promise<number>`; `resequence(exec: Executor, table: SortableTable, id: string, sortOrder: number): Promise<void>`. `EntityKind` and `SortableTable` unchanged (`'account' | 'sleeve' | 'asset'`, `'accounts' | 'sleeves' | 'assets'`). `DeleteBlock` unchanged (`{ holdingCents: number; hasHistory: boolean }`).
  - `server/presets/example.ts` → `insertPortfolio(exec: Executor, accounts: PresetAccount[]): Promise<void>`. Preset types unchanged.
  - `server/app.ts` → `createApp(db: Database): Express`. `HttpError` unchanged. `buildUpdate` removed.
  - `server/test/db.ts` → `loadExample(orm: Database): Promise<void>`.
  - `server/db/pool.ts` → `withTransaction` removed.

- [ ] **Step 1: Rewrite `server/portfolio.ts`**

Replace the whole file with:

```ts
import { desc, eq, sql } from 'drizzle-orm';
import type { Executor } from './db/pool';
import { accounts, assets, investmentLines, sleeves } from './db/schema';
import { actualBps, effectiveTargetBps } from '../shared/rebalance';
import type { Account, Asset, PortfolioState, Sleeve } from '../shared/types';

export type EntityKind = 'account' | 'sleeve' | 'asset';

export interface DeleteBlock {
  holdingCents: number;
  hasHistory: boolean;
}

/** What would stop `id` (of kind `kind`) from being deleted. */
export async function deleteBlockers(
  exec: Executor,
  kind: EntityKind,
  id: string,
): Promise<DeleteBlock> {
  const scope =
    kind === 'asset'
      ? eq(assets.id, id)
      : kind === 'sleeve'
        ? eq(assets.sleeveId, id)
        : sql`${assets.sleeveId} IN (SELECT ${sleeves.id} FROM ${sleeves} WHERE ${sleeves.accountId} = ${id})`;

  const [holding] = await exec
    .select({ cents: sql<number>`coalesce(sum(${assets.holdingCents}), 0)::bigint` })
    .from(assets)
    .where(scope);

  const history = await exec
    .select({ one: sql`1` })
    .from(investmentLines)
    .innerJoin(assets, eq(assets.id, investmentLines.assetId))
    .where(scope)
    .limit(1);

  return { holdingCents: holding.cents, hasHistory: history.length > 0 };
}

const SORT_TABLES = { accounts, sleeves, assets } as const;
export type SortableTable = keyof typeof SORT_TABLES;

/** Next sort_order for a new row: one past the current max within its parent scope. */
export async function nextSortOrder(
  exec: Executor,
  table: SortableTable,
  parentId: string | null,
): Promise<number> {
  const t = SORT_TABLES[table];
  const where =
    table === 'sleeves' && parentId !== null
      ? eq(sleeves.accountId, parentId)
      : table === 'assets' && parentId !== null
        ? eq(assets.sleeveId, parentId)
        : undefined;
  const [row] = await exec
    .select({ next: sql<number>`coalesce(max(${t.sortOrder}), 0) + 1` })
    .from(t)
    .where(where);
  return row.next;
}

/** Update an entity's sort_order to a new position. */
export async function resequence(
  exec: Executor,
  table: SortableTable,
  id: string,
  sortOrder: number,
): Promise<void> {
  const t = SORT_TABLES[table];
  await exec.update(t).set({ sortOrder }).where(eq(t.id, id));
}

export async function readPortfolio(exec: Executor): Promise<PortfolioState> {
  // Contribution room used is derived from the ledger rather than stored, so
  // undoing an investment gives the room back with no extra bookkeeping.
  const usedByAccount = exec
    .select({
      accountId: sleeves.accountId,
      total: sql<number>`sum(${investmentLines.amountCents})::bigint`.as('total'),
    })
    .from(investmentLines)
    .innerJoin(assets, eq(assets.id, investmentLines.assetId))
    .innerJoin(sleeves, eq(sleeves.id, assets.sleeveId))
    .groupBy(sleeves.accountId)
    .as('used');

  // Sequential, not Promise.all: inside a transaction `exec` is a single
  // connection, and there is nothing to gain from parallelism on one.
  const accountRows = await exec
    .select({
      id: accounts.id,
      label: accounts.label,
      note: accounts.note,
      roomLimit: accounts.roomLimit,
      sortOrder: accounts.sortOrder,
      roomUsed: sql<number>`coalesce(${usedByAccount.total}, 0)::bigint`,
    })
    .from(accounts)
    .leftJoin(usedByAccount, eq(usedByAccount.accountId, accounts.id))
    .orderBy(accounts.sortOrder, accounts.id);

  const sleeveRows = await exec
    .select({
      id: sleeves.id,
      accountId: sleeves.accountId,
      label: sleeves.label,
      targetBps: sleeves.targetBps,
      sortOrder: sleeves.sortOrder,
    })
    .from(sleeves)
    .innerJoin(accounts, eq(accounts.id, sleeves.accountId))
    .orderBy(accounts.sortOrder, accounts.id, sleeves.sortOrder, sleeves.id);

  const assetRows = await exec
    .select({
      id: assets.id,
      sleeveId: assets.sleeveId,
      ticker: assets.ticker,
      label: assets.label,
      weightBps: assets.weightBps,
      holdingCents: assets.holdingCents,
      sortOrder: assets.sortOrder,
    })
    .from(assets)
    .innerJoin(sleeves, eq(sleeves.id, assets.sleeveId))
    .innerJoin(accounts, eq(accounts.id, sleeves.accountId))
    .orderBy(
      accounts.sortOrder,
      accounts.id,
      sleeves.sortOrder,
      sleeves.id,
      assets.sortOrder,
      assets.id,
    );

  type AssetRow = (typeof assetRows)[number];
  const totalCents = assetRows.reduce((sum, row) => sum + row.holdingCents, 0);

  const assetsBySleeve = new Map<string, AssetRow[]>();
  for (const row of assetRows) {
    const list = assetsBySleeve.get(row.sleeveId) ?? [];
    list.push(row);
    assetsBySleeve.set(row.sleeveId, list);
  }

  const sleevesOut: Sleeve[] = sleeveRows.map((sleeveRow) => {
    const rows = assetsBySleeve.get(sleeveRow.id) ?? [];
    const assetsOut: Asset[] = rows.map((row) => {
      const actual = actualBps(row.holdingCents, totalCents);
      const effectiveTarget = effectiveTargetBps(sleeveRow.targetBps, row.weightBps);
      return {
        id: row.id,
        sleeveId: row.sleeveId,
        ticker: row.ticker,
        label: row.label,
        weightBps: row.weightBps,
        holdingCents: row.holdingCents,
        effectiveTargetBps: effectiveTarget,
        actualBps: actual,
        driftBps: totalCents > 0 ? actual - effectiveTarget : 0,
        sortOrder: row.sortOrder,
      };
    });

    const holdingCents = assetsOut.reduce((sum, a) => sum + a.holdingCents, 0);
    const actual = actualBps(holdingCents, totalCents);

    return {
      id: sleeveRow.id,
      accountId: sleeveRow.accountId,
      label: sleeveRow.label,
      targetBps: sleeveRow.targetBps,
      sortOrder: sleeveRow.sortOrder,
      assets: assetsOut,
      holdingCents,
      actualBps: actual,
      driftBps: totalCents > 0 ? actual - sleeveRow.targetBps : 0,
      assetWeightTotalBps: assetsOut.reduce((sum, a) => sum + a.weightBps, 0),
    };
  });

  const holdingsByAccount = new Map<string, number>();
  for (const sleeve of sleevesOut) {
    holdingsByAccount.set(
      sleeve.accountId,
      (holdingsByAccount.get(sleeve.accountId) ?? 0) + sleeve.holdingCents,
    );
  }

  const accountsOut: Account[] = accountRows.map((row) => ({
    id: row.id,
    label: row.label,
    note: row.note,
    roomLimitCents: row.roomLimit,
    roomUsedCents: row.roomUsed,
    roomRemainingCents:
      row.roomLimit === null ? null : Math.max(0, row.roomLimit - row.roomUsed),
    holdingCents: holdingsByAccount.get(row.id) ?? 0,
    sortOrder: row.sortOrder,
  }));

  return { accounts: accountsOut, sleeves: sleevesOut, totalCents };
}
```

Notes for the implementer:
- `desc` is imported for parity with `app.ts` usage patterns but is not used here — remove it from the import if `noUnusedLocals` complains (it will). Keep only `eq`, `sql`.
- If TypeScript rejects `t.sortOrder` / `t.id` on the `SORT_TABLES[table]` union, cast: `const t = SORT_TABLES[table] as typeof accounts;`.
- If Drizzle rejects referencing `usedByAccount.total` inside the outer `sql`, inline the subquery expression instead: `roomUsed: sql<number>\`coalesce((SELECT sum(${investmentLines.amountCents}) FROM ${investmentLines} JOIN ${assets} ON ${assets.id} = ${investmentLines.assetId} JOIN ${sleeves} ON ${sleeves.id} = ${assets.sleeveId} WHERE ${sleeves.accountId} = ${accounts.id}), 0)::bigint\`` and drop the `usedByAccount` CTE + its `leftJoin`.

- [ ] **Step 2: Update `server/portfolio.test.ts`**

- Line ~1: remove `import type { PoolClient } from 'pg';` (it becomes unused).
- Line ~18 (`beforeEach`): `await loadExample(db.pool);` → `await loadExample(db.orm);`
- Replace the `read()` helper:

```ts
/** Reads portfolio state straight off the Drizzle handle, like the routes do. */
async function read() {
  return readPortfolio(db.orm);
}
```

- Replace the `withClient` helper and its call sites. Delete the `withClient` function (bottom of file) and change the three `deleteBlockers` describe-block calls from `await withClient((c) => deleteBlockers(c, 'asset', 'us_equity_vti'))` to `await deleteBlockers(db.orm, 'asset', 'us_equity_vti')` (same for the `'sleeve'` and `'account'` calls).
- `recordInvestment` keeps using `db.pool.query(...)` — leave it.

- [ ] **Step 3: Run the portfolio suite (intermediate checkpoint)**

Run: `pnpm test -- server/portfolio.test.ts`
Expected: PASS. This isolates the `portfolio.ts` conversion from the `app.ts` work. If `roomUsedCents` comes back as a string, the `::bigint` cast is missing from the `roomUsed` select expression.

- [ ] **Step 4: Rewrite `insertPortfolio` in `server/presets/example.ts`**

Keep all the `Preset*` interfaces and `EXAMPLE_PORTFOLIO` exactly as they are. Replace the imports and the function:

```ts
import type { Executor } from '../db/pool';
import { accounts, assets, sleeves } from '../db/schema';
```

```ts
/** Assumes an empty database — callers must enforce that before inserting. */
export async function insertPortfolio(exec: Executor, accountsInput: PresetAccount[]): Promise<void> {
  let accountSortOrder = 1;
  for (const account of accountsInput) {
    await exec.insert(accounts).values({
      id: account.id,
      label: account.label,
      note: account.note,
      roomLimit: account.roomLimitCents,
      sortOrder: accountSortOrder++,
    });

    let sleeveSortOrder = 1;
    for (const sleeve of account.sleeves) {
      await exec.insert(sleeves).values({
        id: sleeve.id,
        accountId: account.id,
        label: sleeve.label,
        targetBps: sleeve.targetBps,
        sortOrder: sleeveSortOrder++,
      });

      let assetSortOrder = 1;
      for (const asset of sleeve.assets) {
        await exec.insert(assets).values({
          id: asset.id,
          sleeveId: sleeve.id,
          ticker: asset.ticker,
          label: asset.label,
          weightBps: asset.weightBps,
          sortOrder: assetSortOrder++,
        });
      }
    }
  }
}
```

(The parameter is renamed `accountsInput` so it does not shadow the imported `accounts` table.)

- [ ] **Step 5: Update `loadExample` in `server/test/db.ts`**

Change its signature and body:

```ts
/** Loads the example account/sleeve/asset tree into an (assumed empty) test database. */
export async function loadExample(orm: Database): Promise<void> {
  await orm.transaction((tx) => insertPortfolio(tx, EXAMPLE_PORTFOLIO));
}
```

Remove `withTransaction` from the `../db/pool` import in this file (now unused here).

- [ ] **Step 6: Remove `withTransaction` from `server/db/pool.ts`**

Delete the `withTransaction` function and drop `type PoolClient` from the `pg` import if nothing else references it (the `pg.types` calls and `createPool` do not).

- [ ] **Step 7: Rewrite the head of `server/app.ts`**

Replace the imports and delete `buildUpdate`. New import block:

```ts
import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from './db/pool';
import { accounts, assets, investmentLines, investments, sleeves } from './db/schema';
import { deleteBlockers, nextSortOrder, readPortfolio, resequence } from './portfolio';
import { EXAMPLE_PORTFOLIO, insertPortfolio } from './presets/example';
import {
  allocationIssues,
  MAX_ACCOUNTS,
  MAX_ASSETS_PER_SLEEVE,
  MAX_SLEEVES,
  toRebalanceUnits,
} from '../shared/allocation';
import { planDeposit } from '../shared/rebalance';
import type { InvestmentRecord } from '../shared/types';
```

Delete the entire `buildUpdate` function. Keep `HttpError`, all the Zod schemas, `CENTS_FORMAT`, `formatCentsForMessage`, and `route`.

Add this helper next to `formatCentsForMessage`:

```ts
/** Postgres unique-violation SQLSTATE, whether the error is raw from pg or wrapped by Drizzle. */
function uniqueViolation(error: unknown): boolean {
  const direct = (error as { code?: string }).code;
  const wrapped = (error as { cause?: { code?: string } }).cause?.code;
  return direct === '23505' || wrapped === '23505';
}
```

- [ ] **Step 8: Convert `createApp` + the read routes**

Change the signature to `export function createApp(db: Database): Express {`.

`GET /api/portfolio`:

```ts
  app.get(
    '/api/portfolio',
    route(async (_req, res) => {
      res.json(await readPortfolio(db));
    }),
  );
```

`POST /api/preview`:

```ts
  app.post(
    '/api/preview',
    route(async (req, res) => {
      const { amountCents } = depositSchema.parse(req.body);
      const portfolio = await readPortfolio(db);
      const issue = allocationIssues(portfolio)[0];
      if (issue) throw new HttpError(400, issue.message);
      res.json(planDeposit(toRebalanceUnits(portfolio), portfolio.accounts, amountCents));
    }),
  );
```

`GET /api/history` (kept as raw SQL, run on the Drizzle handle):

```ts
  app.get(
    '/api/history',
    route(async (_req, res) => {
      const result = await db.execute<InvestmentRecord>(sql`
        SELECT i.id,
               i.label             AS "label",
               i.requested_cents   AS "requestedCents",
               i.allocated_cents   AS "allocatedCents",
               i.unallocated_cents AS "unallocatedCents",
               i.created_at        AS "createdAt",
               COALESCE(
                 json_agg(
                   json_build_object(
                     'assetId', l.asset_id,
                     'sleeveId', ast.sleeve_id,
                     'intendedCents', l.intended_cents,
                     'amountCents', l.amount_cents
                   ) ORDER BY l.id
                 ) FILTER (WHERE l.id IS NOT NULL),
                 '[]'
               ) AS lines
          FROM investments i
          LEFT JOIN investment_lines l ON l.investment_id = i.id
          LEFT JOIN assets ast ON ast.id = l.asset_id
         GROUP BY i.id
         ORDER BY i.id DESC
         LIMIT 50
      `);
      res.json(result.rows);
    }),
  );
```

If `db.execute<T>` does not accept a type parameter in the installed Drizzle version, drop it and cast: `res.json(result.rows as unknown as InvestmentRecord[]);`.

- [ ] **Step 9: Convert the account routes**

`POST /api/accounts`:

```ts
  app.post(
    '/api/accounts',
    route(async (req, res) => {
      const body = accountCreateSchema.parse(req.body);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(accounts);
        if (count >= MAX_ACCOUNTS) {
          throw new HttpError(
            409,
            `an account can't be created — the portfolio already has the maximum of ${MAX_ACCOUNTS}`,
          );
        }
        const id = randomUUID();
        const sortOrder = await nextSortOrder(tx, 'accounts', null);
        await tx
          .insert(accounts)
          .values({ id, label: body.label, note: body.note, roomLimit: body.roomLimitCents, sortOrder });
        return readPortfolio(tx);
      });
      res.status(201).json(portfolio);
    }),
  );
```

`PATCH /api/accounts/:id`:

```ts
  app.patch(
    '/api/accounts/:id',
    route(async (req, res) => {
      const patch = accountPatchSchema.parse(req.body);
      const accountId = idSchema.parse(req.params.id);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const existing = await tx
          .select({ one: sql`1` })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1);
        if (existing.length === 0) throw new HttpError(404, 'no account with that id');

        const { sortOrder, ...rest } = patch;
        if (sortOrder !== undefined) {
          await resequence(tx, 'accounts', accountId, sortOrder);
        }
        const columns: Partial<{ label: string; note: string; roomLimit: number | null }> = {};
        if (rest.label !== undefined) columns.label = rest.label;
        if (rest.note !== undefined) columns.note = rest.note;
        if (rest.roomLimitCents !== undefined) columns.roomLimit = rest.roomLimitCents;
        if (Object.keys(columns).length > 0) {
          await tx.update(accounts).set(columns).where(eq(accounts.id, accountId));
        }
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );
```

`DELETE /api/accounts/:id`:

```ts
  app.delete(
    '/api/accounts/:id',
    route(async (req, res) => {
      const accountId = idSchema.parse(req.params.id);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const [row] = await tx
          .select({ label: accounts.label })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1);
        if (!row) throw new HttpError(404, 'no account with that id');

        const { holdingCents, hasHistory } = await deleteBlockers(tx, 'account', accountId);
        if (holdingCents > 0) {
          throw new HttpError(
            409,
            `${row.label} holds ${formatCentsForMessage(holdingCents)} across its sleeves — move or zero out its holdings before deleting.`,
          );
        }
        if (hasHistory) {
          throw new HttpError(
            409,
            `${row.label} has past investments recorded — delete isn't allowed once an account has investment history.`,
          );
        }
        await tx.delete(accounts).where(eq(accounts.id, accountId));
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );
```

- [ ] **Step 10: Convert the sleeve routes**

`POST /api/sleeves`:

```ts
  app.post(
    '/api/sleeves',
    route(async (req, res) => {
      const body = sleeveCreateSchema.parse(req.body);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const parent = await tx
          .select({ one: sql`1` })
          .from(accounts)
          .where(eq(accounts.id, body.accountId))
          .limit(1);
        if (parent.length === 0) throw new HttpError(404, 'no account with that id');

        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(sleeves);
        if (count >= MAX_SLEEVES) {
          throw new HttpError(
            409,
            `a sleeve can't be created — the portfolio already has the maximum of ${MAX_SLEEVES}`,
          );
        }

        const id = randomUUID();
        const sortOrder = await nextSortOrder(tx, 'sleeves', body.accountId);
        await tx
          .insert(sleeves)
          .values({ id, accountId: body.accountId, label: body.label, targetBps: body.targetBps, sortOrder });
        return readPortfolio(tx);
      });
      res.status(201).json(portfolio);
    }),
  );
```

`PATCH /api/sleeves/:id` — same shape as the account PATCH, with:
- existence check on `sleeves` / message `'no sleeve with that id'`
- `resequence(tx, 'sleeves', sleeveId, sortOrder)`
- `const columns: Partial<{ label: string; targetBps: number }> = {};` → `if (rest.label !== undefined) columns.label = rest.label;` and `if (rest.targetBps !== undefined) columns.targetBps = rest.targetBps;`
- `tx.update(sleeves).set(columns).where(eq(sleeves.id, sleeveId))`

`DELETE /api/sleeves/:id` — same shape as the account DELETE, with:
- `tx.select({ label: sleeves.label }).from(sleeves).where(eq(sleeves.id, sleeveId)).limit(1)`
- message `'no sleeve with that id'`
- `deleteBlockers(tx, 'sleeve', sleeveId)`
- 409 copy: `` `${row.label} holds ${formatCentsForMessage(holdingCents)} — move or zero out its holdings before deleting.` `` and `` `${row.label} has past investments recorded — delete isn't allowed once a sleeve has investment history.` ``
- `tx.delete(sleeves).where(eq(sleeves.id, sleeveId))`

- [ ] **Step 11: Convert the asset routes**

`POST /api/assets`:

```ts
  app.post(
    '/api/assets',
    route(async (req, res) => {
      const body = assetCreateSchema.parse(req.body);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const parent = await tx
          .select({ one: sql`1` })
          .from(sleeves)
          .where(eq(sleeves.id, body.sleeveId))
          .limit(1);
        if (parent.length === 0) throw new HttpError(404, 'no sleeve with that id');

        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(assets)
          .where(eq(assets.sleeveId, body.sleeveId));
        if (count >= MAX_ASSETS_PER_SLEEVE) {
          throw new HttpError(
            409,
            `an asset can't be created — this sleeve already has the maximum of ${MAX_ASSETS_PER_SLEEVE}`,
          );
        }

        const id = randomUUID();
        const sortOrder = await nextSortOrder(tx, 'assets', body.sleeveId);
        try {
          await tx.insert(assets).values({
            id,
            sleeveId: body.sleeveId,
            ticker: body.ticker,
            label: body.label,
            weightBps: body.weightBps,
            sortOrder,
          });
        } catch (error) {
          if (uniqueViolation(error)) throw new HttpError(409, `that sleeve already holds ${body.ticker}`);
          throw error;
        }
        return readPortfolio(tx);
      });
      res.status(201).json(portfolio);
    }),
  );
```

`PATCH /api/assets/:id`:

```ts
  app.patch(
    '/api/assets/:id',
    route(async (req, res) => {
      const patch = assetPatchSchema.parse(req.body);
      const assetId = idSchema.parse(req.params.id);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const existing = await tx
          .select({ one: sql`1` })
          .from(assets)
          .where(eq(assets.id, assetId))
          .limit(1);
        if (existing.length === 0) throw new HttpError(404, 'no asset with that id');

        const { sortOrder, ...rest } = patch;
        if (sortOrder !== undefined) {
          await resequence(tx, 'assets', assetId, sortOrder);
        }
        const columns: Partial<{ ticker: string; label: string; weightBps: number }> = {};
        if (rest.ticker !== undefined) columns.ticker = rest.ticker;
        if (rest.label !== undefined) columns.label = rest.label;
        if (rest.weightBps !== undefined) columns.weightBps = rest.weightBps;
        if (Object.keys(columns).length > 0) {
          try {
            await tx.update(assets).set(columns).where(eq(assets.id, assetId));
          } catch (error) {
            if (uniqueViolation(error)) throw new HttpError(409, `that sleeve already holds ${rest.ticker}`);
            throw error;
          }
        }
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );
```

`DELETE /api/assets/:id` — same shape as the account DELETE, with:
- `tx.select({ ticker: assets.ticker }).from(assets).where(eq(assets.id, assetId)).limit(1)`
- message `'no asset with that id'`
- `deleteBlockers(tx, 'asset', assetId)`
- 409 copy uses `row.ticker`: `` `${row.ticker} holds ${formatCentsForMessage(holdingCents)} — move or zero out its holdings before deleting.` `` and `` `${row.ticker} has past investments recorded — delete isn't allowed once an asset has investment history.` ``
- `tx.delete(assets).where(eq(assets.id, assetId))`

- [ ] **Step 12: Convert the remaining routes**

`POST /api/presets/example`:

```ts
  app.post(
    '/api/presets/example',
    route(async (_req, res) => {
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(accounts);
        if (count > 0) {
          throw new HttpError(409, 'the example portfolio can only be loaded into an empty portfolio');
        }
        await insertPortfolio(tx, EXAMPLE_PORTFOLIO);
        return readPortfolio(tx);
      });
      res.status(201).json(portfolio);
    }),
  );
```

`POST /api/invest`:

```ts
  app.post(
    '/api/invest',
    route(async (req, res) => {
      const { amountCents, label } = depositSchema.parse(req.body);

      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE assets IN SHARE ROW EXCLUSIVE MODE`);

        const portfolio = await readPortfolio(tx);
        const issue = allocationIssues(portfolio)[0];
        if (issue) throw new HttpError(400, issue.message);
        const plan = planDeposit(toRebalanceUnits(portfolio), portfolio.accounts, amountCents);

        const [inv] = await tx
          .insert(investments)
          .values({
            label,
            requestedCents: plan.requestedCents,
            allocatedCents: plan.allocatedCents,
            unallocatedCents: plan.unallocatedCents,
          })
          .returning({ id: investments.id });
        const investmentId = inv.id;

        for (const line of plan.lines) {
          await tx.insert(investmentLines).values({
            investmentId,
            assetId: line.assetId,
            intendedCents: line.intendedCents,
            amountCents: line.amountCents,
          });
          if (line.amountCents > 0) {
            await tx
              .update(assets)
              .set({ holdingCents: sql`${assets.holdingCents} + ${line.amountCents}` })
              .where(eq(assets.id, line.assetId));
          }
        }

        return { investmentId, plan, portfolio: await readPortfolio(tx) };
      });

      res.json(result);
    }),
  );
```

(The old code also selected `created_at` in the `RETURNING` clause but never used it — dropped here.)

`POST /api/undo` (the correlated `UPDATE` stays raw):

```ts
  app.post(
    '/api/undo',
    route(async (_req, res) => {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE assets IN SHARE ROW EXCLUSIVE MODE`);

        const [latest] = await tx
          .select({ id: investments.id })
          .from(investments)
          .orderBy(desc(investments.id))
          .limit(1);
        if (!latest) return null;

        await tx.execute(sql`
          UPDATE assets a
             SET holding_cents = GREATEST(0, a.holding_cents - l.amount_cents)
            FROM investment_lines l
           WHERE l.asset_id = a.id AND l.investment_id = ${latest.id}
        `);
        await tx.delete(investments).where(eq(investments.id, latest.id));

        return readPortfolio(tx);
      });

      if (result === null) {
        res.status(409).json({ error: 'there is nothing to undo' });
        return;
      }
      res.json(result);
    }),
  );
```

`PUT /api/holdings`:

```ts
  app.put(
    '/api/holdings',
    route(async (req, res) => {
      const { holdings } = holdingsSchema.parse(req.body);
      const portfolio = await db.transaction(async (tx) => {
        for (const [assetId, cents] of Object.entries(holdings)) {
          const updated = await tx.update(assets).set({ holdingCents: cents }).where(eq(assets.id, assetId));
          if ((updated.rowCount ?? 0) === 0) throw new HttpError(404, `unknown asset: ${assetId}`);
        }
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );
```

- [ ] **Step 13: Update `server/index.ts` and `server/api.test.ts` construction**

`server/index.ts`:

```ts
import { createApp } from './app';
import { createDb, createPool } from './db/pool';

const PORT = Number(process.env.PORT ?? 3001);

createApp(createDb(createPool())).listen(PORT, () => {
  console.log(`invest-buddy api listening on http://localhost:${PORT}`);
});
```

`server/api.test.ts`:
- `app = createApp(db.pool);` → `app = createApp(db.orm);`
- `await loadExample(db.pool);` → `await loadExample(db.orm);`
- Every other `db.pool.query(...)` assertion in the file stays as is.

- [ ] **Step 14: Full gates**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: PASS, all suites. Common failures and fixes:
- `noUnusedLocals` on `desc` in `portfolio.ts` → remove it from that import.
- Union-type errors on `SORT_TABLES[table]` → cast `as typeof accounts` (see Step 1 notes).
- `roomUsedCents`/`count` arriving as strings → the `::int` / `::bigint` casts in the `sql<number>` expressions are missing.
- `23505` no longer caught → confirm `uniqueViolation` checks both `error.code` and `error.cause?.code`.
- History route shape mismatch → the raw SQL must be byte-for-byte the old query; re-diff against git.

- [ ] **Step 15: Commit**

```bash
git add server/portfolio.ts server/portfolio.test.ts server/presets/example.ts server/test/db.ts server/db/pool.ts server/app.ts server/index.ts server/api.test.ts
git commit -m "Move the server data layer onto Drizzle (#11)"
```

---

## Task 5: CI + documentation

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: the `db:check` script (Task 1).

- [ ] **Step 1: Add the drift check to CI**

In `.github/workflows/ci.yml`, add a step immediately before `- run: pnpm test`:

```yaml
      # Fails if server/db/schema.ts has changed without a matching migration.
      - run: pnpm db:check
```

`drizzle-kit check` compares the schema against the committed migration snapshots and needs no database, so it can sit anywhere after `pnpm install`.

- [ ] **Step 2: Verify `db:check` locally**

Run: `pnpm db:check`
Expected: reports no conflicts / up to date, exit `0`. Then make a throwaway edit to `server/db/schema.ts` (add a nullable column), run `pnpm db:check` again, confirm it now complains, and revert the edit.

- [ ] **Step 3: Update the README "Running it" section**

Replace the fenced setup block (currently `pnpm install` / `createdb invest_buddy` / `pnpm db:reset` / `pnpm dev`) with:

```bash
pnpm install

# One-time: create the database and bring it up to date.
pnpm db:reset

pnpm dev          # api on :3001, web on :5173
```

Under **First run**, change "`pnpm db:reset` only loads `schema.sql`" to "`pnpm db:reset` recreates the database from the migrations in `server/db/migrations/`, so the app starts with an empty portfolio."

Add, after that paragraph:

```markdown
Applying a new migration to an existing database (without wiping it) is `pnpm db:migrate`.
```

- [ ] **Step 4: Update the "Connecting to the database with psql" section**

The `psql -d invest_buddy` guidance stays. In **If psql is not found**, change the closing note so it no longer implies `db:reset` needs `psql`: `db:reset` now runs through `tsx`/`pg` and does not shell out to `psql`; the PATH fix only matters for interactive `psql`.

- [ ] **Step 5: Update the "Schema reference" and "Resetting" subsections**

- "Schema reference" line: change "`\dt` lists the five tables ... `\d assets` describes one" to also point at the source: "The schema is defined in `server/db/schema.ts`; generated SQL lives in `server/db/migrations/`."
- "Resetting": replace "`pnpm db:reset` drops every table and reloads `schema.sql` ... It also shells out to `psql`, so it needs the PATH fix above." with: "`pnpm db:reset` drops and recreates the database, then replays every migration. **It destroys all recorded investments and holdings** and leaves the portfolio empty. Use the app's "Load example portfolio" button (or `POST /api/presets/example`) afterwards to get the example data back."

- [ ] **Step 6: Add a "Changing the schema" subsection**

Add after "Resetting":

```markdown
### Changing the schema

1. Edit `server/db/schema.ts`.
2. `pnpm db:generate` — writes a new SQL file under `server/db/migrations/`.
3. Read the generated SQL and commit it with the schema change.
4. `pnpm db:migrate` to apply it to your local database (or `pnpm db:reset` to rebuild from scratch).

CI runs `pnpm db:check`, which fails if `schema.ts` changed without a matching migration.
```

- [ ] **Step 7: Update the "Scripts" table**

Change the `db:reset` row and add three rows:

```markdown
| `pnpm db:reset`  | Drop the database, recreate it, and replay all migrations (portfolio starts empty) |
| `pnpm db:generate`| Generate a migration from changes to `server/db/schema.ts` |
| `pnpm db:migrate`| Apply pending migrations to `DATABASE_URL` |
| `pnpm db:check`  | Verify `schema.ts` and the committed migrations agree |
```

- [ ] **Step 8: Update the "Tests" and "Layout" sections**

- In the "Tests" paragraph, change "creates a throwaway database per test file from the same `schema.sql` the app ships" to "creates a throwaway database per test file and brings it up to date with the generated Drizzle migrations".
- In the "Layout" tree: change `server/ app.ts — createApp(pool): every route, pool injected.` to `createApp(db): every route, Drizzle instance injected.`; change `index.ts — entrypoint: builds a pool and listens.` to `builds the db and listens.`; change `db/ — schema.sql, connection pool.` to `db/ — schema.ts, migrations/, connection pool, reset script.`

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "Document the Drizzle migration workflow; check drift in CI (#11)"
```

---

## Task 6: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Clean gates from a fresh install**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: all PASS. Record the test count (should be within a test or two of the pre-change ~150 — the only intentional removal is any `buildUpdate` unit test, of which there were none; `server/db/schema.test.ts` adds four).

- [ ] **Step 2: Manual smoke against a real database**

```bash
pnpm db:reset
pnpm dev
```

In another shell:

```bash
curl -s localhost:3001/api/portfolio            # {"accounts":[],"sleeves":[],"totalCents":0}
curl -s -XPOST localhost:3001/api/presets/example | jq '.accounts | length'   # 3
curl -s -XPOST localhost:3001/api/invest -H 'content-type: application/json' -d '{"amountCents":1000000}' | jq '.plan.allocatedCents'
curl -s -XPOST localhost:3001/api/undo | jq '.totalCents'                     # 0
curl -s localhost:3001/api/history | jq 'length'                              # 0
```

Expected: the example portfolio loads, the deposit splits onto the target weights, undo returns the money and clears history.

- [ ] **Step 3: Spec parity self-check**

Re-read `docs/superpowers/specs/2026-09-03-orm-migration-integration-design.md`. Confirm each of Parts 1–3 is reflected in the branch, and note the two deliberate deviations for the reviewer:
1. Write routes use `db.transaction(...)` rather than the spec's "`withTransaction` stays pool-based" — a single Drizzle transaction carries both the raw `LOCK` and the query-builder calls on one connection, and `withTransaction` is removed as dead code.
2. `deleteBlockers`'s account scope uses a small `sql` `IN (SELECT ...)` fragment rather than a pure query-builder subquery; it still removes the old identifier-string interpolation.

- [ ] **Step 4: Push and open the PR** (only after the user confirms)

```bash
git push -u origin orm-migration-integration
gh pr create --draft --fill
```

---

## Self-Review

**1. Spec coverage**

| Spec item | Task |
| --- | --- |
| `drizzle.config.ts` at root | Task 1 Step 4 |
| `server/db/schema.ts` as source of truth | Task 1 Step 5 |
| `server/db/migrations/` committed | Task 1 Steps 6–8 |
| `schema.sql` deleted | Task 3 Step 3 |
| 1:1 schema port (types, checks, FKs, uniques, indexes) | Task 1 Step 5 + Step 7 parity diff; Task 2 Step 4 introspection test |
| `bigint({ mode: 'number' })` + keep global INT8 parser | Task 1 Step 5; Global Constraints; Task 2 Step 1 |
| `0000_init` hand-verified against `schema.sql` | Task 1 Step 7 |
| `createDb(pool)` returning a typed Drizzle instance | Task 2 Step 1 |
| `createApp` takes `db` | Task 4 Step 8 |
| Transactions via `db.transaction` | Task 4 Steps 9–12 (deviation noted, Task 6 Step 3) |
| `portfolio.ts` converted; `*Row` interfaces dropped | Task 4 Step 1 |
| `presets/example.ts` converted | Task 4 Step 4 |
| `app.ts` straightforward queries converted; `buildUpdate` deleted | Task 4 Steps 7–12 |
| `LOCK TABLE`, `/api/undo` update, `/api/history` kept raw | Task 4 Steps 8, 12 |
| `23505` catch preserved | Task 4 Step 7 (`uniqueViolation`), Steps 11 |
| `server/test/db.ts` via migrator + `TRUNCATE` reset + `orm` field | Task 2 Step 2 |
| `server/db/schema.test.ts` introspection | Task 2 Step 4 |
| CI `db:check` before `pnpm test` | Task 5 Step 1 |
| `db:generate` / `db:migrate` / `db:check` scripts | Task 1 Step 2 |
| `db:reset` rewritten as a Node script; no `psql` | Task 3 Steps 1–2 |
| `drizzle-orm` dep + `drizzle-kit` devDep | Task 1 Step 1 |
| README: setup, psql note, schema reference, resetting, "Changing the schema", scripts, tests, layout | Task 5 Steps 3–8 |
| Existing suites are the safety net; only construction changes | Task 4 Steps 2, 13 |
| Manual smoke: reset, load example, invest, undo | Task 6 Step 2 |
| Out-of-scope tracked in #15 | n/a (issue exists) |

No uncovered spec items.

**2. Placeholder scan** — no "TBD"/"handle appropriately"/"write tests for the above"/"similar to Task N" left; every code step carries full code. The sleeve and asset PATCH/DELETE routes in Task 4 Steps 10–11 are given as explicit deltas against fully-shown sibling routes in the same task (the account routes), not cross-task references.

**3. Type consistency** — `Executor` / `Database` / `Transaction` defined in Task 2 Step 1 and consumed with the same names in Tasks 3–4. `readPortfolio(exec)`, `deleteBlockers(exec, kind, id)`, `nextSortOrder(exec, table, parentId)`, `resequence(exec, table, id, sortOrder)`, `insertPortfolio(exec, accountsInput)`, `createApp(db)`, `loadExample(orm)` signatures match between their defining task and every call site. `TestDatabase.orm` added in Task 2 and used in Task 4. Table object names (`accounts`, `sleeves`, `assets`, `investments`, `investmentLines`) consistent across `schema.ts`, `portfolio.ts`, `presets/example.ts`, `app.ts`.
