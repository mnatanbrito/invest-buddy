# Integrate database ORM library — design

**Issue:** [#11 Integrate database ORM library](https://github.com/mnatanbrito/invest-buddy/issues/11)
**Date:** 2026-09-03
**Status:** Final — awaiting user review before implementation planning
**Follow-up:** out-of-scope work tracked in [#15](https://github.com/mnatanbrito/invest-buddy/issues/15).

## User story

As an engineer, I want to leverage a proper ORM to write code that interacts with
the database.

### Acceptance criteria

- Choose an established library with great community support.
- The library should provide facilities for versioning / schema migration.

## Decisions locked in

| Decision | Choice | Rationale |
| --- | --- | --- |
| Library | **Drizzle ORM + drizzle-kit** | TS-first, thin layer over SQL, preserves the explicit control this codebase values (`LOCK TABLE`, transactions, raw-SQL escape hatch), reuses the existing `pg` Pool, no codegen binary / query engine, strong current community momentum. |
| Scope | **Migrations + convert the straightforward queries** | Define schema in Drizzle, replace `schema.sql` with generated SQL migrations, rewrite `portfolio.ts`, `presets/example.ts`, and the simple CRUD/count/insert queries in `app.ts` to Drizzle's query builder. Keep raw SQL (via Drizzle's `sql` escape hatch) for the deliberately hand-tuned parts: `LOCK TABLE` statements and the `/api/history` JSON aggregation. |
| Test harness | **Run the Drizzle migrator + `TRUNCATE` to reset** | Each per-file test DB is built by running the generated migration files through Drizzle's migrator, so the suite exercises the real migration chain. `reset()` switches to `TRUNCATE ... RESTART IDENTITY CASCADE`. |

## Current state (what changes)

- Hand-written SQL in `server/app.ts`, `server/portfolio.ts`, `server/presets/example.ts`.
- Single `server/db/schema.sql` applied via `pnpm db:reset` (`psql -f schema.sql`).
- `server/test/db.ts` builds throwaway per-file test databases from that same `schema.sql`;
  `reset()` re-runs the DDL to wipe between tests.
- `server/db/pool.ts` — `pg` Pool factory + `withTransaction` helper + global `INT8 -> Number` type parser.
- CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck`, `test`, `build` against a Postgres service container.
- README documents `pnpm db:reset` and the schema.

---

## Part 1 — Layout, schema definition, migrations

### New files / config

- **`drizzle.config.ts`** (repo root) — `dialect: 'postgresql'`, `schema: './server/db/schema.ts'`,
  `out: './server/db/migrations'`, `dbCredentials` from `DATABASE_URL` (falling back to the existing
  `DEFAULT_CONNECTION_STRING`).
- **`server/db/schema.ts`** — the Drizzle table definitions; new single source of truth for the DB shape.
- **`server/db/migrations/`** — generated SQL migration files + `meta/` snapshots, committed to git.
- **`server/db/schema.sql`** — **deleted**. `0000_init.sql` (first generated migration) replaces it.

### Schema translation (`schema.sql` -> `schema.ts`) — faithful 1:1 port, no schema changes

- `accounts`, `sleeves`, `assets`: `text('id').primaryKey()` (still app-generated `randomUUID()`),
  other columns as `text` / `integer`, money columns as `bigint('...', { mode: 'number' })`.
- `investments`, `investment_lines`: `serial('id').primaryKey()`,
  `timestamp('created_at', { withTimezone: true }).notNull().defaultNow()`.
- All `CHECK` constraints (`account_label_present`, `room_limit_non_negative`, `target_bps_valid`,
  `weight_bps_valid`, `holding_non_negative`, `requested_positive`, `allocation_balances`,
  `amounts_non_negative`) reproduced via Drizzle's `check()` helper with their existing names.
- FKs with current delete behaviour: `onDelete: 'cascade'` for sleeves->accounts, assets->sleeves,
  investment_lines->investments; **no** cascade on investment_lines->assets (keeps the RESTRICT that
  makes historical assets undeletable).
- Composite uniques (`asset_ticker_unique_in_sleeve`, the two `investment_lines` uniques) and all four
  explicit indexes (`sleeves_account_idx`, `assets_sleeve_idx`, `investment_lines_investment_idx`,
  `investment_lines_asset_idx`) carried over; PK / unique-constraint backing indexes come for free.
- `pg.types.setTypeParser(INT8, Number)` in `pool.ts` stays as-is; `{ mode: 'number' }` in the schema
  just makes Drizzle's inferred types agree with it.

### Migrations

- Generated with `drizzle-kit generate` (produces reviewable `.sql` files — keeps SQL visible).
  Applied with `drizzle-kit migrate` for humans and `migrate()` from
  `drizzle-orm/node-postgres/migrator` programmatically (tests).
- `0000_init.sql` is hand-verified to match today's `schema.sql` exactly before commit (diff a dump
  of a DB built from each).
- Drizzle's bookkeeping table (`drizzle.__drizzle_migrations`) lives in its own schema, so it stays
  clear of the app tables and `TRUNCATE`.

---

## Part 2 — Connection layer & query conversion

### `server/db/pool.ts`

- Keep `createPool`, `withTransaction`, and the global `INT8 -> Number` parser unchanged.
- Add a `createDb(pool)` helper returning `drizzle(pool, { schema })` — a typed Drizzle instance
  bound to the same pool. `createApp` takes the Drizzle `db` instead of a bare `Pool` (it still
  holds `db.$client` / the pool for the raw-SQL cases). `server/index.ts` becomes
  `createApp(createDb(createPool()))`; tests construct it from their throwaway pool the same way.
- `withTransaction` stays pool-based for the routes that issue `LOCK TABLE` + raw SQL; Drizzle calls
  inside a transaction use `db.transaction(async (tx) => ...)`. Routes that mix both run raw `LOCK`
  via ``tx.execute(sql`LOCK TABLE ...`)`` then query-builder calls on the same `tx`.

### `server/portfolio.ts` — converted to the query builder

- `ACCOUNTS_QUERY`, `SLEEVES_QUERY`, `ASSETS_QUERY` become Drizzle
  `select().from().leftJoin().orderBy()` expressions. The `room_used` correlated subquery becomes a
  Drizzle subquery. Hand-written `AccountRow` / `SleeveRow` / `AssetRow` interfaces are dropped in
  favour of Drizzle's inferred row types.
- `nextSortOrder`, `resequence`, `deleteBlockers` — converted; the dynamic table names
  (`accounts` / `sleeves` / `assets`) map to a lookup of schema table objects rather than string
  interpolation, removing the current interpolation-of-identifiers pattern.
- The rollup math in `readPortfolio` (drift, actualBps, totals) is untouched — it already operates
  on plain objects.

### `server/presets/example.ts`

- `insertPortfolio` — the three nested `INSERT` loops become
  `db.insert(accounts/sleeves/assets).values(...)`. Same batching semantics inside the caller's
  transaction.

### `server/app.ts` — per-route

- **Converted to query builder:** the `COUNT(*)` cap checks, `SELECT 1` existence checks, `INSERT`
  for accounts/sleeves/assets, the `buildUpdate` PATCH paths (replaced by
  `db.update().set(partial).where(eq(id))` — `buildUpdate` is deleted), the `investments` /
  `investment_lines` inserts and the `assets.holding_cents` increment in `/api/invest`, the
  `/api/undo` delete, `/api/holdings` updates.
- **Kept raw** (via `sql` / `tx.execute`): every `LOCK TABLE ... IN SHARE ROW EXCLUSIVE MODE`, the
  `/api/undo` correlated `UPDATE ... FROM investment_lines`, and the `/api/history` `json_agg`
  aggregation. These keep their exact current SQL; the Postgres `23505` unique-violation catch stays.
- Zod schemas, `HttpError`, the `route()` wrapper, error messages — all unchanged.

### Net deletions

`buildUpdate` + its test, the three `*Row` interfaces, `schema.sql`.

---

## Part 3 — Test harness, CI, scripts, docs, testing strategy

### `server/test/db.ts`

- Drop `readFileSync` of `schema.sql`. After `CREATE DATABASE`, build the schema by calling
  `migrate(drizzle(pool), { migrationsFolder: 'server/db/migrations' })`.
- `reset()` -> `TRUNCATE accounts, sleeves, assets, investments, investment_lines RESTART IDENTITY CASCADE`
  (one statement). Resets `SERIAL` sequences so `investments.id` starts at 1 each test, matching
  current behaviour. `drizzle.__drizzle_migrations` is in a separate schema, untouched.
- `TestDatabase` gains a `db` (Drizzle instance) alongside `pool`; `createApp` is called with `db`.
  `loadExample` takes `db`.
- The per-file `CREATE DATABASE` + migrator run adds a few hundred ms per test file. Acceptable; a
  template database is a possible later optimisation, out of scope here.

### CI (`.github/workflows/ci.yml`)

- Add a step before `pnpm test`: **`pnpm db:check`** (`drizzle-kit check`) — fails if `schema.ts`
  has drifted from the committed migrations (schema changed without a generated migration). No live
  DB needed.
- No migration-run step against a shared DB is needed — the test harness migrates its own throwaway
  DBs, and `pnpm build` doesn't touch the database.

### `package.json` scripts

- `db:generate` -> `drizzle-kit generate` (author a migration after editing `schema.ts`)
- `db:migrate` -> `drizzle-kit migrate` (apply pending migrations to `DATABASE_URL`)
- `db:check` -> `drizzle-kit check` (used by CI too)
- `db:reset` -> **rewritten**: drop + recreate the local `invest_buddy` DB, then `drizzle-kit migrate`.
  Small Node script (mirrors `server/test/db.ts`'s admin-connection pattern) instead of shelling to
  `psql`, so it no longer needs `psql` on PATH. Still lands on an empty portfolio.
- `dev:api` / `dev` unchanged. Server boot does **not** auto-migrate (keeps prod/dev explicit);
  README tells devs to run `pnpm db:migrate`.

### Dependencies

- Add `drizzle-orm` (dep) and `drizzle-kit` (devDep). `pg` stays.

### README

- Setup section: `pnpm db:reset` still the one-liner; add `pnpm db:migrate` for applying new
  migrations to an existing DB. Update the "if psql is not found" note — `db:reset` no longer needs
  `psql` (interactive `psql -d invest_buddy` still documented for poking at data).
- "Schema reference" section points at `server/db/schema.ts` + `server/db/migrations/` instead of
  `schema.sql`.
- Project-layout tree: `db/schema.ts`, `db/migrations/` replace `db/schema.sql`.
- Add a short "Changing the schema" subsection: edit `schema.ts` -> `pnpm db:generate` -> review the
  SQL -> commit -> `pnpm db:migrate`.

### Testing strategy for this change

- The existing `server/*.test.ts` suites are the safety net — they exercise every converted query
  end to end against real Postgres. They should pass unchanged except for construction
  (`createApp(db)` vs `createApp(pool)`) and the deleted `buildUpdate` test.
- Add `server/db/schema.test.ts`: spin up a throwaway DB via the migrator and assert the introspected
  constraints / indexes exist (constraint names, the FK `ON DELETE` actions, the composite uniques) —
  locks down the 1:1 port and catches future migration drift.
- Manual check before merge: `pnpm db:reset` on a clean local DB, run the app, load the example
  portfolio, do an invest + undo.
- Verify `0000_init.sql` against `schema.sql` by diffing a dump of a DB built from each.

---

## Out of scope

Tracked as follow-up issue [#15](https://github.com/mnatanbrito/invest-buddy/issues/15):

- Repository / data-access layer refactor (extract query modules out of `app.ts`).
- Converting the remaining raw SQL to Drizzle: the `LOCK TABLE` statements and the `/api/history`
  `json_agg` aggregation.
- Seed / preset data changes.
- Any schema redesign.
- Connection-pool tuning; test-harness template-database optimisation.
