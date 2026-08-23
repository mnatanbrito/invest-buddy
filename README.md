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

If `psql` and `createdb` are not on your PATH (Homebrew keeps PostgreSQL
keg-only), add them:

```bash
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
```

Point at a different database with `DATABASE_URL`.

### First run

Open **Settings** and set your real RRSP and TFSA contribution room from your CRA
Notice of Assessment, plus any balances you already hold. **The room figures that
ship in the seed are placeholders, not real CRA limits.**

## Scripts

| Script           | What it does                                     |
| ---------------- | ------------------------------------------------ |
| `pnpm dev`       | API and web dev server together                  |
| `pnpm test`      | Rebalancing engine unit tests                    |
| `pnpm typecheck` | Typecheck client and server                      |
| `pnpm build`     | Production build                                 |
| `pnpm db:reset`  | Drop, recreate and reseed all tables             |

## Layout

```
shared/         rebalance.ts — the engine, plus its tests. Pure, no I/O.
                types.ts     — contracts shared by API and client.
server/         index.ts     — Express API.
                portfolio.ts — reads portfolio state out of Postgres.
                db/          — schema.sql, seed.sql, connection pool.
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
