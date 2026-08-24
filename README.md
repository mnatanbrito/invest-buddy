# Invest Buddy

A rebalancing calculator for a fixed Canadian couch-potato ETF allocation across
an RRSP, a TFSA and a non-registered account.

You type in how much you want to invest. The app works out where the money should
go, shows it landing on the allocation diagram, and records it so the next
deposit accounts for what you already hold.

## The allocation

Weights are percentages of the **total** portfolio and sum to 100.

| Sleeve                | Tickers     | Target | Account         |
| --------------------- | ----------- | -----: | --------------- |
| US total market       | VTI or ITOT |    45% | RRSP            |
| Canadian bonds        | VAB or XBB  |    10% | RRSP            |
| Canadian equity       | VCN or XIC  |    20% | TFSA            |
| International (EAFE)  | XEF or VIU  |    15% | TFSA            |
| Emerging markets      | VEE or XEC  |    10% | Non-registered  |

## How deposits are split

**Drift-aware cash-flow rebalancing.** A deposit does not get carved up by the
fixed target weights. It flows to whichever sleeves sit furthest *below* their
target, pulling the portfolio back toward the targets without ever selling
anything.

For each sleeve the engine computes how far below target it would sit once the
deposit lands, clamps that at zero so overweight sleeves get nothing, and splits
the deposit in proportion to those shortfalls. When nothing is overweight the
shortfalls sum to exactly the deposit, so every sleeve lands precisely on target.

**Contribution room caps, and does not redirect.** If a deposit would push the
RRSP or TFSA past its remaining room, that account's lines are scaled down to
fit and the blocked remainder is reported as unallocated cash for you to place
yourself. It is never silently moved to another account.

All money is handled as integer cents with largest-remainder rounding, so the
lines always sum to exactly the deposit.

## Running it

Requires Node 20+, pnpm, and PostgreSQL running locally.

```bash
pnpm install

# One-time: create the database, then load schema + seed.
createdb invest_buddy
pnpm db:reset

pnpm dev          # api on :3001, web on :5173
```

Point at a different database with `DATABASE_URL`.

### First run

Open **Settings** and set your real RRSP and TFSA contribution room from your CRA
Notice of Assessment, plus any balances you already hold. **The room figures that
ship in the seed are placeholders, not real CRA limits.**

## Connecting to the database with psql

The app connects to `postgresql://localhost:5432/invest_buddy` by default, with no
username or password — a stock local PostgreSQL install authenticates you as your
own OS user. Override it with `DATABASE_URL` if your setup differs.

```bash
psql -d invest_buddy
```

### If psql is not found

Homebrew keeps PostgreSQL keg-only, so its binaries are installed but left off your
PATH. Add them for the current shell:

```bash
# Apple Silicon; use /usr/local/opt on Intel, and match your installed version.
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
```

Make it permanent by appending that line to `~/.zshrc`. To find the right path for
your machine:

```bash
brew --prefix postgresql@18   # then append /bin
```

Check the server is actually up before assuming a connection problem:

```bash
pg_isready                 # expects: /tmp:5432 - accepting connections
brew services list         # shows whether postgresql@18 is started
```

### Useful queries

Every money column is stored as **integer cents**, and `target_bps` is in basis
points (10000 = 100%). Divide when reading them by hand.

Current holdings against their targets:

```sql
SELECT s.tickers,
       (s.target_bps / 100.0)::numeric(5,2)     AS target_pct,
       (s.holding_cents / 100.0)::numeric(14,2) AS holding
  FROM sleeves s
 ORDER BY s.sort_order;
```

Contribution room, with usage derived from the ledger the same way the API derives
it (`room_limit` is NULL for non-registered, meaning no limit):

```sql
SELECT a.label,
       (a.room_limit / 100.0)::numeric(14,2)                     AS room_limit,
       (COALESCE(SUM(l.amount_cents), 0) / 100.0)::numeric(14,2) AS used
  FROM accounts a
  LEFT JOIN sleeves s ON s.account_id = a.id
  LEFT JOIN investment_lines l ON l.sleeve_id = s.id
 GROUP BY a.label, a.room_limit, a.sort_order
 ORDER BY a.sort_order;
```

Investment history, newest first:

```sql
SELECT i.id,
       i.created_at,
       (i.requested_cents / 100.0)::numeric(14,2)   AS requested,
       (i.unallocated_cents / 100.0)::numeric(14,2) AS held_back_as_cash
  FROM investments i
 ORDER BY i.id DESC;
```

Schema reference: `\dt` lists the four tables, `\d sleeves` describes one.

### Resetting

`pnpm db:reset` drops every table and reloads schema plus seed. **It destroys all
recorded investments and holdings.** It also shells out to `psql`, so it needs the
PATH fix above.


## Scripts

| Script           | What it does                                     |
| ---------------- | ------------------------------------------------ |
| `pnpm dev`       | API and web dev server together                  |
| `pnpm test`      | Full unit test suite (needs local Postgres)      |
| `pnpm test:watch`| Same suite in watch mode                         |
| `pnpm lint`      | oxlint; any warning fails the run                |
| `pnpm typecheck` | Typecheck client and server                      |
| `pnpm build`     | Production build                                 |
| `pnpm db:reset`  | Drop, recreate and reseed all tables             |

## Tests

```bash
pnpm test
```

Around 77 tests covering the rebalancing engine, money parsing and formatting,
diagram geometry, the portfolio reader and every API endpoint. No React rendering
tests — the logic those components rely on is covered directly.

**The server tests need a running local PostgreSQL.** They do not touch your
`invest_buddy` database: `server/test/db.ts` creates a throwaway database per test
file, seeded from the same `schema.sql` and `seed.sql` the app ships, and drops it
afterwards. It connects through `pg` rather than shelling out to `createdb`, so it
does not need `psql` on your PATH. Set `DATABASE_URL` to point the tests at a
different server.

The API tests run against `createApp(pool)` via supertest without binding a port,
which is why `server/index.ts` is only an entrypoint and all the routes live in
`server/app.ts`.

## Contributing

`main` is pull-request-only: a repository ruleset blocks direct pushes, force-pushes
and deletions, and holds the merge button until the `ci` workflow is green. That
applies to everyone, including the repo owner — there is no bypass list.

CI runs `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` on every PR,
with PostgreSQL supplied as a service container so the database-backed tests run
for real.

One-time setup in a fresh clone, so a mistaken `git push origin main` is caught
locally instead of by the server:

```bash
git config core.hooksPath .githooks
```

Git does not share hooks through a clone, and `core.hooksPath` is per-clone
configuration, so this cannot be automated away without a dependency.

## Layout

```
shared/         rebalance.ts — the engine, plus its tests. Pure, no I/O.
                types.ts     — contracts shared by API and client.
server/         app.ts       — createApp(pool): every route, pool injected.
                index.ts     — entrypoint: builds a pool and listens.
                portfolio.ts — reads portfolio state out of Postgres.
                db/          — schema.sql, seed.sql, connection pool.
                test/db.ts   — throwaway seeded database for tests.
src/            App.tsx      — page shell, amount input, invest flow.
                components/diagram/ — the SVG allocation diagram.
                lib/         — API client and money formatting.
```

The client previews a deposit by running the same engine the server runs, so the
diagram and the write can never disagree. The server still re-plans
authoritatively inside a transaction against locked rows, so a stale preview can
never write the wrong amounts.

## Caveats

- This is a bookkeeping and arithmetic tool. It does not place trades, read your
  brokerage, or know current prices — holdings are book values you and it record
  together.
- It is not financial advice.
