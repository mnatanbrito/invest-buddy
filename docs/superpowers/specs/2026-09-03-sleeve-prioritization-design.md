# Sleeve (account) prioritization when allocating a deposit — design

**Date:** 2026-09-03
**Status:** Final — awaiting user review before implementation planning

## User story

As someone planning a deposit, I want to mark one or more accounts as
**prioritized** so the deposit fills them toward their target *first* — up to each
account's remaining contribution room — before the rest of the money flows to the
other accounts, without letting my overall asset mix drift.

### Worked example (the acceptance test)

Portfolio:

| Account | Contribution room | Sleeve | Target % of portfolio | Assets |
| --- | ---: | --- | ---: | --- |
| RRSP | $87,901.00 | All-in-one Stock ETF | 45% | XEQT (100%) |
| RRSP | (same account) | Canadian bonds | 10% | ZAG (100%) |
| TFSA | $32,200.85 | All-in-one Stock ETF | 45% | XEQT (100%) |

Stocks are 90% of the target, bonds 10%. Deposit **$100,000**, prioritize
**TFSA**. Expected allocation:

- TFSA All-in-one Stock ETF → **$32,200.85** (its full remaining room; it is prioritized and its 45% share of the deposit, $45,000, exceeds the room).
- RRSP All-in-one Stock ETF → **$57,799.15** ($45,000 base + the $12,799.15 that overflowed TFSA, redirected to the other sleeve holding XEQT).
- RRSP Canadian bonds → **$10,000.00** (unchanged — the redirect preserves the stock/bond mix).

Total: $100,000.00, nothing held as cash. RRSP's own room ($87,901) is not
exceeded.

## Decisions locked in

| Decision | Choice | Rationale |
| --- | --- | --- |
| What gets prioritized | **An account** | The example's "RRSP/TFSA sleeve target" — a container with a dollar limit holding multiple percentage-weighted sleeves — is an `Account` in the current model. |
| The dollar limit | **The account's existing remaining contribution room** (`roomRemainingCents`) | No new field, no schema migration. |
| When the choice is made | **Per-deposit** | The decision is situational ("this year, fill the TFSA first"). Keeping it per-deposit makes it visible with live preview feedback, avoids a stored flag that silently changes every future deposit, and needs no migration. A persisted default can layer on later without rework. |
| How much a prioritized account gets first | **Its normal drift-aware target share, capped at its room** | Only the excess over the room is redirected. The limit is a ceiling, not a floor — a prioritized account is never overfilled beyond its target share. |
| Where prioritized overflow goes | **Redirected to non-prioritized units holding the same ticker**, preserving asset mix | Matches the worked example. Overflow that has no same-ticker home falls back to cash. |
| Redirect passes | **Single pass, same-ticker only** | No multi-hop rehoming. A redirect that overflows its recipient's room becomes cash. |

## Current state (what changes)

- `shared/rebalance.ts` — `planDeposit(units, accounts, depositCents)`: drift-aware
  apportionment, then a per-account room-cap pass whose blocked remainder becomes
  unallocated cash and is **never** redirected. `RebalanceUnit` has
  `id` (assetId), `sleeveId`, `accountId`, `targetWeight`, `holdingCents` — **no ticker**.
- `shared/allocation.ts` — `toRebalanceUnits(portfolio)` builds units from
  `sleeve.assets`.
- `shared/types.ts` — `AllocationLine` (`intendedCents`, `amountCents`,
  `blockedCents`) and `AllocationPlan` (`requestedCents`, `allocatedCents`,
  `unallocatedCents`, `lines`, `cappedAccountIds`).
- `server/app.ts` — `depositSchema` (`amountCents`, `label`); `/api/preview` and
  `/api/invest` both call `planDeposit(toRebalanceUnits(portfolio), portfolio.accounts, amountCents)`.
  `/api/invest` re-plans authoritatively inside a locked transaction.
- `src/App.tsx` — Plan view invest form (amount + label + Invest); previews by
  running `planDeposit` client-side; renders cash-shortfall messaging.
- `src/lib/api.ts` — `api.preview` / `api.invest`.
- README — "How deposits are split" section.

---

## Part 1 — Engine (`shared/rebalance.ts`, `shared/allocation.ts`)

### Signature

```ts
export function planDeposit(
  units: RebalanceUnit[],
  accounts: RebalanceAccount[],
  depositCents: number,
  prioritizedAccountIds: readonly string[] = [],
): AllocationPlan
```

`RebalanceUnit` gains `ticker: string`. `toRebalanceUnits` populates it from the
asset row (`asset.ticker`, already uppercased on input).

Passing `[]` (or omitting the argument) MUST produce byte-identical output to
today.

### Algorithm

Let `prioritized = new Set(prioritizedAccountIds)`, `totalAfter = Σ holdingCents + deposit`.

**Phase 1 — base plan (unchanged).**
`needs[i] = max(0, targetWeight_i · totalAfter − holdingCents_i · WEIGHT_SCALE)`.
`base = apportion(needs, deposit)` — sums to the deposit exactly. Initialise
`amounts = base.slice()`, `redirected[i] = 0n`, `blocked[i] = 0n` for reporting.

**Phase 2 — prioritized redirect.** For each `account` in `accounts` where
`prioritized.has(account.id)` **and** `account.roomRemainingCents !== null`:

1. `room = BigInt(max(0, account.roomRemainingCents))`.
2. `idx` = indices of units with `accountId === account.id`;
   `wanted = Σ amounts[i] for i in idx`.
3. If `wanted <= room`, continue (fits within room and target share).
4. `fitted = apportion(amounts[idx], room)`. For each `k, i` in `idx`:
   `freed = amounts[i] − fitted[k]`; `amounts[i] = fitted[k]`;
   if `freed > 0`, record `pool[units[i].ticker].push({ i, freed })`.
5. Push `account.id` onto `cappedAccountIds`.

Then, for each ticker with a non-empty pool, let `sources` be its recorded
`{ i, freed }` entries and `poolCents = Σ freed`:

- `recipients` = indices `r` where `!prioritized.has(units[r].accountId)`
  **and** `units[r].ticker === ticker` **and** `units[r].targetWeight > 0`.
- **If `recipients` is empty:** the overflow cannot preserve the mix. For each
  source, `blocked[i] += freed` (it becomes unallocated cash and shows as
  `blockedCents` on that line). Continue.
- Otherwise distribute the pool: `remaining[r] = max(0, targetWeight_r · totalAfter
  − (holdingCents_r + amounts[r]) · WEIGHT_SCALE)`. `weights = remaining[recipients]`;
  if `Σ weights === 0`, `weights = targetWeight[recipients]`.
  `add = apportion(weights, poolCents)`. For each `k, r`: `amounts[r] += add[k]`;
  `redirected[r] += add[k]`.
- Charge the placed cents back to the sources: for each source,
  `redirected[i] −= freed` (the whole pool was placed, so this nets to zero
  against the recipients' `+add`).

**Phase 3 — non-prioritized room cap (unchanged behavior).** For each `account`
where `!prioritized.has(account.id)` and `roomRemainingCents !== null`: if the
account's total `amounts` (base + any redirect received) exceeds `room`, scale its
units down with `apportion(amounts[idx], room)`, add the reduction per unit to
`blocked[i]`, and push `account.id` onto `cappedAccountIds`. The blocked remainder
is **not** redirected — it becomes unallocated cash.

**Phase 4 — line assembly & totals.** Per line:
`intendedCents = base[i]`, `redirectedCents = redirected[i]`,
`blockedCents = blocked[i]`, `amountCents = amounts[i]`. These satisfy the
identity `amountCents === intendedCents + redirectedCents − blockedCents`.
`allocatedCents = Σ amountCents`; `unallocatedCents = depositCents − allocatedCents`
(equals `Σ blockedCents`).

### Cent-exactness

Every scale-down (Phase 2 step 4, Phase 3) and every pool distribution goes
through `apportion`, so `Σ lines.amountCents + unallocatedCents === depositCents`
always holds. Placed redirect cents net out between sources and recipients, so
`Σ lines.redirectedCents === 0`; overflow with no same-ticker recipient lands in
`blockedCents`, never in `redirectedCents`.

---

## Part 2 — Shared types (`shared/types.ts`)

`AllocationLine`:

| Field | Change | Meaning |
| --- | --- | --- |
| `intendedCents` | unchanged | What drift wanted before any capping or redirect (Phase 1 `base[i]`). |
| `amountCents` | semantics relaxed | Final amount. **May exceed `intendedCents`** on a redirect recipient. Identity: `amountCents === intendedCents + redirectedCents − blockedCents`. |
| `blockedCents` | redefined | Cents that fell out to cash: room ran out (Phase 3), or a prioritized overflow had no same-ticker home (Phase 2). Always `>= 0`. No longer simply `intendedCents − amountCents`. |
| `redirectedCents` | **new** `number` | Signed net redirect effect: negative on a prioritized overflow line (placed portion only), positive on a recipient line, `0` otherwise. `Σ === 0` across all lines. |

`AllocationPlan`:

| Field | Change | Meaning |
| --- | --- | --- |
| `prioritizedAccountIds` | **new** `string[]` | Echo of the request, so the UI can phrase capped prioritized accounts differently from ordinary capped ones. |
| `redirectedCents` | **new** `number` | Total cents moved by the mix-preserving redirect (Σ of the positive line `redirectedCents`); `0` when nothing was prioritized. |
| `cappedAccountIds` | semantics widened | Any account scaled down to its room, now possibly including prioritized accounts. |

---

## Part 3 — API (`server/app.ts`, `src/lib/api.ts`)

`depositSchema` gains:

```ts
prioritizedAccountIds: z.array(idSchema).max(MAX_ACCOUNTS).optional().default([])
```

`/api/preview` and `/api/invest` both parse it and thread it into
`planDeposit(toRebalanceUnits(portfolio), portfolio.accounts, amountCents, prioritizedAccountIds)`.
`/api/invest` re-plans authoritatively inside the locked transaction — same call,
same extra argument.

Validation: any id in `prioritizedAccountIds` that is not an account in the
current portfolio → `400` (`"unknown account in prioritizedAccountIds"`). The pure
engine ignores ids it does not recognise; the 400 is an API-layer guard.

`investment_lines` already records `intendedCents` and `amountCents` per line, and
`amountCents` now carries the redirected result — history stays correct with no
schema change. The prioritization *choice itself* is not persisted in v1.

`src/lib/api.ts` — `api.preview` and `api.invest` gain a `prioritizedAccountIds:
string[]` argument, sent in the JSON body.

---

## Part 4 — Client UI (`src/App.tsx`)

**Control.** In the Plan view invest form, a "Prioritize filling" control listing
only accounts with a finite `roomRemainingCents`. Multi-select (checkboxes in a
small popover, or inline checkboxes when ≤3 qualify). Backed by
`const [prioritizedAccountIds, setPrioritizedAccountIds] = useState<string[]>([])`.
If no account has a finite room limit, the control is not rendered.

**Wiring.** `prioritizedAccountIds` feeds the `preview` `useMemo`'s `planDeposit`
call and `api.invest(...)`. Toggling it re-runs the preview and re-animates the
diagram amounts — no diagram code change; flows already render from plan amounts.
The `preview` `useMemo` dependency array gains `prioritizedAccountIds`.

**Messaging** (below the existing cash-shortfall line):

- `preview.redirectedCents > 0` → "Filling {prioritized account(s)} to their
  contribution room first — {formatCents(redirectedCents)} redirected to {recipient
  account(s)} to keep your asset mix."
- Prioritized overflow that became cash (no same-ticker recipient) →
  "{formatCents(blocked)} from {account} couldn't be redirected — no other sleeve
  holds {ticker} — and stays as cash."
- The current "contribution room ran out" message still fires for ordinary capped
  accounts.

Diagram tinting of redirected flows is **out of scope for v1**.

---

## Part 5 — Testing

### `shared/rebalance.test.ts` — new `describe('prioritized accounts')`

- **Worked example, exact.** Fixture: RRSP (room $87,901) with an `XEQT` stock
  sleeve at 45% + a `ZAG` bonds sleeve at 10%; TFSA (room $32,200.85) with an
  `XEQT` stock sleeve at 45%. Deposit $100,000, prioritize TFSA →
  `57799.15 / 10000.00 / 32200.85`, `redirectedCents === 1_279_915`,
  `unallocatedCents === 0`.
- Prioritized account whose target share is **under** its room → no redirect;
  output identical to the no-priority call.
- Prioritized account with `roomRemainingCents === null` → no-op.
- Overflow ticker with **no** non-prioritized recipient → cents reported as
  `blockedCents` on the source line, `redirectedCents === 0` on that line, and
  counted in `unallocatedCents`.
- Redirect recipient pushed past **its own** room by the redirect → Phase 3 scales
  it back, excess → cash (locks in the documented v1 limitation).
- **Two** prioritized accounts → each capped to room independently, combined
  overflow pooled per ticker and redistributed.
- Invariants: `Σ line.redirectedCents === 0`; per line `amountCents === intendedCents
  + redirectedCents − blockedCents` with `blockedCents >= 0`; `allocated + unallocated
  === deposit`; every account's assigned total ≤ its room. Extend the existing
  500-trial random test to also pass a random prioritized subset each trial.

### `server/api.test.ts`

- `/api/preview` with `prioritizedAccountIds` returns a redirected plan carrying
  the new fields.
- `/api/invest` with `prioritizedAccountIds` writes `assets.holding_cents`
  matching the redirected `amountCents`, and `investment_lines` rows carry the
  redirected amounts.
- Unknown id in `prioritizedAccountIds` → `400`.
- Omitted `prioritizedAccountIds` → behavior identical to today (regression guard).

### `shared/allocation.test.ts`

- `toRebalanceUnits` output carries `ticker`.

---

## Part 6 — Edge cases (codified)

1. Prioritized account with unlimited room (`null`) → no finite limit to fill to;
   prioritization is a no-op and the UI does not offer it.
2. Ticker pool with no eligible non-prioritized recipient → held as cash, reported
   as `blockedCents` on the prioritized source line; the message names the ticker.
3. Redirect into a non-prioritized account that then exceeds its own room → Phase 3
   scales it back; bounced cents become cash. Redirect is single-pass — it does
   not hunt for the next-best same-ticker home.
4. All accounts prioritized → every finite-room account capped to room, no
   recipients, remainder to cash ("fill everything to its limit, rest is cash").
5. `prioritizedAccountIds` with a non-existent id → API returns `400`; the pure
   engine ignores unknown ids.
6. Same ticker in multiple non-prioritized sleeves → pool split across them by
   remaining drift need, target-weight fallback when all are already at/over target.
7. Deposit ≤ the prioritized account's room **and** its target share → output
   identical to today.
8. Cent-exactness holds through every scale-down and pool distribution
   (all via `apportion`).

---

## Part 7 — Non-goals (v1)

- No persisted prioritization: no schema migration, no Edit-view toggle, no
  default.
- No priority *ranking* between multiple prioritized accounts — they are peers,
  each capped independently, overflow pooled.
- The prioritization choice is not recorded in investment history (the resulting
  amounts are).
- No diagram styling for redirected flows.
- No multi-hop / non-same-ticker rehoming of redirected cents.
