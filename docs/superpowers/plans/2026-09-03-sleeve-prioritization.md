# Sleeve (account) prioritization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a deposit fill one or more chosen accounts toward their target first — capped at each account's remaining contribution room — and redirect the overflow to other sleeves holding the same ticker so the asset mix is preserved.

**Architecture:** A new optional `prioritizedAccountIds` argument on the pure `planDeposit` engine drives a three-phase algorithm: (1) the existing drift-aware apportionment, (2) scale each prioritized account down to its room and redistribute the freed cents per-ticker to non-prioritized units, (3) the existing non-prioritized room cap. The two API routes thread the argument through unchanged otherwise; the client sends it from a new multi-select in the Plan view. No database migration — the "limit" is the account's existing `roomRemainingCents`.

**Tech Stack:** TypeScript, Vitest, Express + Zod, Drizzle ORM (untouched here), React 19, shadcn/Radix dropdown-menu.

**Spec:** `docs/superpowers/specs/2026-09-03-sleeve-prioritization-design.md`

## Global Constraints

- All money is integer cents; every split goes through `apportion` (largest-remainder) so lines sum to exactly the deposit.
- `pnpm lint` (`oxlint --deny-warnings`) — any warning fails CI.
- `pnpm typecheck` — `tsc -b --noEmit && tsc -p tsconfig.server.json`.
- `pnpm db:check` must stay green — this feature adds **no** schema change, so `server/db/schema.ts` must not be modified.
- `pnpm test` needs a local PostgreSQL running (server/API tests build throwaway databases).
- Passing `[]` (or omitting the new argument/param) MUST produce byte-identical output to today.
- Per-line identity: `amountCents === intendedCents + redirectedCents − blockedCents`, with `blockedCents >= 0`.
- Cross-line invariant: `Σ redirectedCents === 0`.
- `main` is PR-only; work happens on branch `feat/sleeve-prioritization` (already created).

---

### Task 1: Add `ticker` to `RebalanceUnit`

**Files:**
- Modify: `shared/rebalance.ts` (the `RebalanceUnit` interface, ~line 8-16)
- Modify: `shared/allocation.ts` (`toRebalanceUnits`, ~line 63-73)
- Test: `shared/allocation.test.ts` (the `toRebalanceUnits` describe, ~line 98-109)
- Test: `shared/rebalance.test.ts` (the `unit` helper, ~line 21-36)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `RebalanceUnit` now has `ticker: string`. `toRebalanceUnits(portfolio: PortfolioState): RebalanceUnit[]` populates it from `asset.ticker`. Test helper `unit(id, sleeveId, accountId, sleeveTargetBps, assetWeightBps, holdingCents, ticker?)` — `ticker` defaults to `id`.

- [ ] **Step 1: Update the `toRebalanceUnits` test to expect `ticker`**

In `shared/allocation.test.ts`, replace the `expect(units).toEqual([...])` block inside `describe('toRebalanceUnits')` with:

```ts
    expect(units).toEqual([
      { id: 'x', sleeveId: 'a', accountId: 'acct', ticker: 'x', targetWeight: 4500 * 7000, holdingCents: 0 },
      { id: 'y', sleeveId: 'a', accountId: 'acct', ticker: 'y', targetWeight: 4500 * 3000, holdingCents: 0 },
    ]);
```

(The `asset` helper in this file already sets `ticker: id`, so the expected tickers are `'x'` and `'y'`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run shared/allocation.test.ts -t toRebalanceUnits`
Expected: FAIL — actual objects lack the `ticker` key.

- [ ] **Step 3: Add `ticker` to the interface and the mapper**

In `shared/rebalance.ts`, add the field to `RebalanceUnit`:

```ts
export interface RebalanceUnit {
  /** assetId */
  id: string;
  sleeveId: string;
  accountId: string;
  /** The asset's ticker, uppercased. Units with the same ticker are interchangeable
   *  when redirecting a prioritized account's overflow. */
  ticker: string;
  /** sleeve.targetBps * asset.weightBps, in [0, WEIGHT_SCALE]. */
  targetWeight: number;
  holdingCents: number;
}
```

In `shared/allocation.ts`, `toRebalanceUnits`, add `ticker` to the mapped object:

```ts
export function toRebalanceUnits(portfolio: PortfolioState): RebalanceUnit[] {
  return portfolio.sleeves.flatMap((sleeve) =>
    sleeve.assets.map((asset) => ({
      id: asset.id,
      sleeveId: sleeve.id,
      accountId: sleeve.accountId,
      ticker: asset.ticker,
      targetWeight: effectiveWeight(sleeve.targetBps, asset.weightBps),
      holdingCents: asset.holdingCents,
    })),
  );
}
```

- [ ] **Step 4: Update the `unit` test helper so `shared/rebalance.test.ts` still type-checks**

In `shared/rebalance.test.ts`, change the `unit` helper to accept and return a `ticker` (default `id`):

```ts
function unit(
  id: string,
  sleeveId: string,
  accountId: string,
  sleeveTargetBps: number,
  assetWeightBps: number,
  holdingCents: number,
  ticker: string = id,
): RebalanceUnit {
  return {
    id,
    sleeveId,
    accountId,
    ticker,
    targetWeight: effectiveWeight(sleeveTargetBps, assetWeightBps),
    holdingCents,
  };
}
```

- [ ] **Step 5: Run the full shared suite + typecheck**

Run: `pnpm vitest run shared/ && pnpm typecheck`
Expected: PASS. All existing `shared/rebalance.test.ts` cases still green (they build units only through the helper); the `toRebalanceUnits` test now passes.

- [ ] **Step 6: Commit**

```bash
git add shared/rebalance.ts shared/allocation.ts shared/allocation.test.ts shared/rebalance.test.ts
git commit -m "Add ticker to RebalanceUnit for mix-preserving redirect"
```

---

### Task 2: `planDeposit` prioritization — types, algorithm, engine tests

**Files:**
- Modify: `shared/types.ts` (`AllocationLine` ~line 61-73, `AllocationPlan` ~line 75-83)
- Modify: `shared/rebalance.ts` (`planDeposit`, ~line 65-126)
- Test: `shared/rebalance.test.ts` (new `describe`, plus extend the random-invariant test ~line 158-194)

**Interfaces:**
- Consumes: `RebalanceUnit.ticker` (Task 1).
- Produces:
  - `planDeposit(units: RebalanceUnit[], accounts: RebalanceAccount[], depositCents: number, prioritizedAccountIds?: readonly string[]): AllocationPlan` — new optional 4th argument, default `[]`.
  - `AllocationLine` gains `redirectedCents: number`.
  - `AllocationPlan` gains `prioritizedAccountIds: string[]` and `redirectedCents: number`.

- [ ] **Step 1: Extend the shared types**

In `shared/types.ts`, add to `AllocationLine` (after `blockedCents`):

```ts
  /** `intendedCents - amountCents`: blocked by contribution room, or a prioritized
   *  overflow with no same-ticker home. Always >= 0. */
  blockedCents: number;
  /** Net effect of the mix-preserving redirect on this line: negative on a
   *  prioritized account's overflow line (placed portion only), positive on a
   *  recipient line, 0 otherwise. Sums to 0 across all lines.
   *  Invariant: amountCents === intendedCents + redirectedCents - blockedCents. */
  redirectedCents: number;
```

And to `AllocationPlan` (after `cappedAccountIds`):

```ts
  /** Ids of accounts whose contribution room capped this deposit. */
  cappedAccountIds: string[];
  /** Echo of the request: accounts that were asked to fill first (and exist in
   *  the portfolio). Empty when nothing was prioritized. */
  prioritizedAccountIds: string[];
  /** Total cents moved from prioritized accounts to same-ticker sleeves elsewhere.
   *  0 when nothing was prioritized. */
  redirectedCents: number;
```

- [ ] **Step 2: Write the failing worked-example test**

In `shared/rebalance.test.ts`, add near the other `describe` blocks:

```ts
describe('prioritized accounts', () => {
  // The spec's acceptance example: XEQT held in both stock sleeves, ZAG only in bonds.
  const exampleUnits = (): RebalanceUnit[] => [
    unit('rrsp_stock', 'rrsp_stock', 'rrsp', 4500, 10_000, 0, 'XEQT'),
    unit('rrsp_bonds', 'rrsp_bonds', 'rrsp', 1000, 10_000, 0, 'ZAG'),
    unit('tfsa_stock', 'tfsa_stock', 'tfsa', 4500, 10_000, 0, 'XEQT'),
  ];
  const exampleAccounts: RebalanceAccount[] = [
    { id: 'rrsp', roomRemainingCents: 8_790_100 }, // $87,901.00
    { id: 'tfsa', roomRemainingCents: 3_220_085 }, // $32,200.85
  ];

  it('fills the prioritized account to its room and redirects the overflow to the same ticker', () => {
    const plan = planDeposit(exampleUnits(), exampleAccounts, 10_000_000, ['tfsa']);
    expect(byId(plan)).toEqual({
      rrsp_stock: 5_779_915,
      rrsp_bonds: 1_000_000,
      tfsa_stock: 3_220_085,
    });
    expect(plan.unallocatedCents).toBe(0);
    expect(plan.redirectedCents).toBe(1_279_915);
    expect(plan.prioritizedAccountIds).toEqual(['tfsa']);
    expect(plan.cappedAccountIds).toEqual(['tfsa']);

    const bySleeveRedirect = Object.fromEntries(plan.lines.map((l) => [l.assetId, l.redirectedCents]));
    expect(bySleeveRedirect).toEqual({
      rrsp_stock: 1_279_915,
      rrsp_bonds: 0,
      tfsa_stock: -1_279_915,
    });
    expect(plan.lines.reduce((s, l) => s + l.redirectedCents, 0)).toBe(0);
    for (const l of plan.lines) {
      expect(l.amountCents).toBe(l.intendedCents + l.redirectedCents - l.blockedCents);
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run shared/rebalance.test.ts -t "prioritized accounts"`
Expected: FAIL — `planDeposit` ignores the 4th argument; `plan.redirectedCents` is `undefined`.

- [ ] **Step 4: Implement the three-phase algorithm**

Replace the body of `planDeposit` in `shared/rebalance.ts` with:

```ts
export function planDeposit(
  units: RebalanceUnit[],
  accounts: RebalanceAccount[],
  depositCents: number,
  prioritizedAccountIds: readonly string[] = [],
): AllocationPlan {
  if (!Number.isInteger(depositCents) || depositCents <= 0) {
    throw new RangeError(`deposit must be a positive whole number of cents, got ${depositCents}`);
  }

  const deposit = BigInt(depositCents);
  const totalHoldings = units.reduce((sum, u) => sum + BigInt(u.holdingCents), 0n);
  const totalAfter = totalHoldings + deposit;
  const prioritized = new Set(prioritizedAccountIds);

  // Phase 1: drift-aware base plan (unchanged from the pre-prioritization engine).
  const needs = units.map((u) => {
    const shortfall = BigInt(u.targetWeight) * totalAfter - BigInt(u.holdingCents) * WEIGHT_SCALE;
    return shortfall > 0n ? shortfall : 0n;
  });
  const base = apportion(needs, deposit);

  const amounts = base.slice();
  const redirected = units.map(() => 0n);
  const blocked = units.map(() => 0n);
  const cappedAccountIds: string[] = [];

  const indicesFor = (accountId: string) =>
    units.flatMap((u, i) => (u.accountId === accountId ? [i] : []));

  // Phase 2: fill each prioritized account to its remaining room, pooling the
  // freed cents by ticker and handing them to non-prioritized units of the same
  // ticker so the asset mix is preserved.
  const pool = new Map<string, { index: number; freed: bigint }[]>();

  for (const account of accounts) {
    if (!prioritized.has(account.id) || account.roomRemainingCents === null) continue;

    const room = BigInt(Math.max(0, account.roomRemainingCents));
    const indices = indicesFor(account.id);
    const wanted = indices.reduce((sum, i) => sum + amounts[i], 0n);
    if (wanted <= room) continue;

    const fitted = apportion(
      indices.map((i) => amounts[i]),
      room,
    );
    indices.forEach((i, k) => {
      const freed = amounts[i] - fitted[k];
      amounts[i] = fitted[k];
      if (freed > 0n) {
        const entry = pool.get(units[i].ticker) ?? [];
        entry.push({ index: i, freed });
        pool.set(units[i].ticker, entry);
      }
    });
    cappedAccountIds.push(account.id);
  }

  for (const [ticker, sources] of pool) {
    const poolCents = sources.reduce((sum, s) => sum + s.freed, 0n);
    const recipients = units.flatMap((u, i) =>
      !prioritized.has(u.accountId) && u.ticker === ticker && u.targetWeight > 0 ? [i] : [],
    );

    if (recipients.length === 0) {
      // No same-ticker home: the overflow stays as cash, charged to its sources.
      for (const s of sources) blocked[s.index] += s.freed;
      continue;
    }

    const remaining = recipients.map((i) => {
      const shortfall =
        BigInt(units[i].targetWeight) * totalAfter -
        (BigInt(units[i].holdingCents) + amounts[i]) * WEIGHT_SCALE;
      return shortfall > 0n ? shortfall : 0n;
    });
    const weights = remaining.some((w) => w > 0n)
      ? remaining
      : recipients.map((i) => BigInt(units[i].targetWeight));

    const add = apportion(weights, poolCents);
    recipients.forEach((i, k) => {
      amounts[i] += add[k];
      redirected[i] += add[k];
    });
    for (const s of sources) redirected[s.index] -= s.freed;
  }

  // Phase 3: cap each non-prioritized account at its room (unchanged behavior).
  // The blocked remainder is held as cash and is never redirected.
  for (const account of accounts) {
    if (prioritized.has(account.id) || account.roomRemainingCents === null) continue;

    const room = BigInt(Math.max(0, account.roomRemainingCents));
    const indices = indicesFor(account.id);
    const wanted = indices.reduce((sum, i) => sum + amounts[i], 0n);
    if (wanted <= room) continue;

    const fitted = apportion(
      indices.map((i) => amounts[i]),
      room,
    );
    indices.forEach((i, k) => {
      blocked[i] += amounts[i] - fitted[k];
      amounts[i] = fitted[k];
    });
    cappedAccountIds.push(account.id);
  }

  const lines: AllocationLine[] = units.map((u, i) => ({
    assetId: u.id,
    sleeveId: u.sleeveId,
    accountId: u.accountId,
    intendedCents: Number(base[i]),
    amountCents: Number(amounts[i]),
    blockedCents: Number(blocked[i]),
    redirectedCents: Number(redirected[i]),
  }));

  const allocatedCents = lines.reduce((sum, l) => sum + l.amountCents, 0);
  const redirectedCents = lines.reduce((sum, l) => (l.redirectedCents > 0 ? sum + l.redirectedCents : sum), 0);
  const knownPrioritized = [...prioritized].filter((id) => units.some((u) => u.accountId === id));

  return {
    requestedCents: depositCents,
    allocatedCents,
    unallocatedCents: depositCents - allocatedCents,
    lines,
    cappedAccountIds,
    prioritizedAccountIds: knownPrioritized,
    redirectedCents,
  };
}
```

- [ ] **Step 5: Run the worked-example test to verify it passes**

Run: `pnpm vitest run shared/rebalance.test.ts -t "prioritized accounts"`
Expected: PASS.

- [ ] **Step 6: Add the remaining engine cases**

Append inside the `describe('prioritized accounts', ...)` block:

```ts
  it('is a no-op when the prioritized account fits within its room', () => {
    const bare = planDeposit(exampleUnits(), exampleAccounts, 1_000_000);
    const prio = planDeposit(exampleUnits(), exampleAccounts, 1_000_000, ['tfsa']);
    expect(byId(prio)).toEqual(byId(bare));
    expect(prio.redirectedCents).toBe(0);
    expect(prio.cappedAccountIds).toEqual([]);
    expect(prio.prioritizedAccountIds).toEqual(['tfsa']);
  });

  it('is a no-op when the prioritized account has unlimited room', () => {
    const accounts: RebalanceAccount[] = [
      { id: 'rrsp', roomRemainingCents: 8_790_100 },
      { id: 'tfsa', roomRemainingCents: null },
    ];
    const bare = planDeposit(exampleUnits(), accounts, 10_000_000);
    const prio = planDeposit(exampleUnits(), accounts, 10_000_000, ['tfsa']);
    expect(byId(prio)).toEqual(byId(bare));
    expect(prio.redirectedCents).toBe(0);
  });

  it('holds overflow as cash when no non-prioritized sleeve shares the ticker', () => {
    // tfsa_stock is now XEIT, held nowhere else.
    const units: RebalanceUnit[] = [
      unit('rrsp_stock', 'rrsp_stock', 'rrsp', 4500, 10_000, 0, 'XEQT'),
      unit('rrsp_bonds', 'rrsp_bonds', 'rrsp', 1000, 10_000, 0, 'ZAG'),
      unit('tfsa_stock', 'tfsa_stock', 'tfsa', 4500, 10_000, 0, 'XEIT'),
    ];
    const plan = planDeposit(units, exampleAccounts, 10_000_000, ['tfsa']);
    expect(byId(plan)).toEqual({
      rrsp_stock: 4_500_000,
      rrsp_bonds: 1_000_000,
      tfsa_stock: 3_220_085,
    });
    expect(plan.redirectedCents).toBe(0);
    expect(plan.unallocatedCents).toBe(1_279_915);
    const tfsaLine = plan.lines.find((l) => l.assetId === 'tfsa_stock')!;
    expect(tfsaLine.blockedCents).toBe(1_279_915);
    expect(tfsaLine.redirectedCents).toBe(0);
  });

  it('lets redirected cents that overflow a non-prioritized account fall back to cash', () => {
    // RRSP has almost no room, so it cannot absorb the redirect from TFSA.
    const accounts: RebalanceAccount[] = [
      { id: 'rrsp', roomRemainingCents: 4_600_000 }, // fits its own $45k base, little more
      { id: 'tfsa', roomRemainingCents: 3_220_085 },
    ];
    const plan = planDeposit(exampleUnits(), accounts, 10_000_000, ['tfsa']);
    expect(plan.allocatedCents + plan.unallocatedCents).toBe(10_000_000);
    expect(plan.unallocatedCents).toBeGreaterThan(0);
    expect(plan.cappedAccountIds).toEqual(expect.arrayContaining(['tfsa', 'rrsp']));
    for (const l of plan.lines) {
      expect(l.amountCents).toBe(l.intendedCents + l.redirectedCents - l.blockedCents);
      expect(l.blockedCents).toBeGreaterThanOrEqual(0);
    }
    for (const account of accounts) {
      const used = plan.lines
        .filter((l) => l.accountId === account.id)
        .reduce((s, l) => s + l.amountCents, 0);
      expect(used).toBeLessThanOrEqual(account.roomRemainingCents!);
    }
  });

  it('caps two prioritized accounts independently and pools their overflow per ticker', () => {
    const units: RebalanceUnit[] = [
      unit('rrsp_stock', 'rrsp_stock', 'rrsp', 3000, 10_000, 0, 'XEQT'),
      unit('tfsa_stock', 'tfsa_stock', 'tfsa', 3000, 10_000, 0, 'XEQT'),
      unit('nr_stock', 'nr_stock', 'nr', 4000, 10_000, 0, 'XEQT'),
    ];
    const accounts: RebalanceAccount[] = [
      { id: 'rrsp', roomRemainingCents: 1_000_000 },
      { id: 'tfsa', roomRemainingCents: 1_000_000 },
      { id: 'nr', roomRemainingCents: null },
    ];
    const plan = planDeposit(units, accounts, 10_000_000, ['rrsp', 'tfsa']);
    expect(byId(plan)).toEqual({
      rrsp_stock: 1_000_000,
      tfsa_stock: 1_000_000,
      nr_stock: 8_000_000, // its own $4m base + $2m + $2m redirected
    });
    expect(plan.redirectedCents).toBe(4_000_000);
    expect(plan.unallocatedCents).toBe(0);
    expect(plan.lines.reduce((s, l) => s + l.redirectedCents, 0)).toBe(0);
  });
```

- [ ] **Step 7: Extend the random-invariant test with a prioritized subset**

In `shared/rebalance.test.ts`, inside `describe('invariants')` → `it('never loses or invents a cent, across many random deposits', ...)`, after `const deposit = 1 + rand(5_000_000);` add:

```ts
      const maybePriority = [
        ...(rand(2) === 0 ? ['rrsp'] : []),
        ...(rand(2) === 0 ? ['tfsa'] : []),
      ];
      const plan = planDeposit(units(holdings), accounts, deposit, maybePriority);
```

(Replace the existing `const plan = planDeposit(units(holdings), accounts, deposit);` line.) Then add these assertions alongside the existing ones in the same loop body:

```ts
      expect(plan.lines.reduce((s, l) => s + l.redirectedCents, 0)).toBe(0);
      for (const l of plan.lines) {
        expect(l.amountCents).toBe(l.intendedCents + l.redirectedCents - l.blockedCents);
        expect(l.blockedCents).toBeGreaterThanOrEqual(0);
      }
```

- [ ] **Step 8: Run the full shared suite + typecheck**

Run: `pnpm vitest run shared/ && pnpm typecheck`
Expected: PASS — every new case green, all pre-existing `planDeposit` cases unchanged (they omit the 4th argument).

- [ ] **Step 9: Commit**

```bash
git add shared/types.ts shared/rebalance.ts shared/rebalance.test.ts
git commit -m "planDeposit: prioritize accounts with mix-preserving overflow redirect"
```

---

### Task 3: API — accept, validate and thread `prioritizedAccountIds`

**Files:**
- Modify: `server/app.ts` (imports ~line 6-17, `depositSchema` ~line 40-46, `/api/preview` ~line 498-507, `/api/invest` ~line 514-558)
- Test: `server/api.test.ts` (new cases in the existing `describe('POST /api/preview')` and `describe('POST /api/invest')`, plus one new `describe`)

**Interfaces:**
- Consumes: `planDeposit(..., prioritizedAccountIds)` and the new `AllocationPlan` fields (Task 2).
- Produces: `/api/preview` and `/api/invest` accept an optional `prioritizedAccountIds: string[]` in the JSON body; an id not present in the portfolio → `400 { error: "unknown account in prioritizedAccountIds: <id>" }`. Omitted → default `[]`, behavior unchanged.

- [ ] **Step 1: Write the failing API tests**

In `server/api.test.ts`, add to the existing `describe('POST /api/preview', ...)`:

```ts
  it('echoes prioritizedAccountIds and caps the prioritized account at its room', async () => {
    // TFSA target is 35%; $200k would send $70k there, past its $25k example room.
    const { body } = await request(app)
      .post('/api/preview')
      .send({ amountCents: 20_000_000, prioritizedAccountIds: ['tfsa'] })
      .expect(200);

    const plan = body as AllocationPlan;
    expect(plan.prioritizedAccountIds).toEqual(['tfsa']);
    expect(plan.cappedAccountIds).toContain('tfsa');
    const tfsaUsed = plan.lines
      .filter((l) => ['cad_equity_vcn', 'intl_equity_xef'].includes(l.assetId))
      .reduce((s, l) => s + l.amountCents, 0);
    expect(tfsaUsed).toBe(2_500_000); // the example TFSA room
    // The example portfolio has no shared tickers, so the overflow becomes cash.
    expect(plan.redirectedCents).toBe(0);
    expect(plan.unallocatedCents).toBeGreaterThan(0);
    expect(plan.allocatedCents + plan.unallocatedCents).toBe(20_000_000);
  });

  it('rejects an unknown account id in prioritizedAccountIds', async () => {
    const { body } = await request(app)
      .post('/api/preview')
      .send({ amountCents: 1_000_000, prioritizedAccountIds: ['nope'] })
      .expect(400);
    expect(body.error).toBe('unknown account in prioritizedAccountIds: nope');
  });

  it('is unchanged when prioritizedAccountIds is omitted', async () => {
    const withField = await request(app)
      .post('/api/preview')
      .send({ amountCents: 1_000_000, prioritizedAccountIds: [] })
      .expect(200);
    const without = await request(app)
      .post('/api/preview')
      .send({ amountCents: 1_000_000 })
      .expect(200);
    expect(assetAmounts(withField.body as AllocationPlan)).toEqual(
      assetAmounts(without.body as AllocationPlan),
    );
  });
```

And a new `describe` for the redirect end-to-end (build a portfolio with a shared ticker via the API):

```ts
describe('POST /api/invest with prioritized accounts', () => {
  /** RRSP (XEQT 45% + ZAG 10%) + TFSA (XEQT 45%), rooms $87,901 / $32,200.85. */
  async function buildSharedTickerPortfolio() {
    const rrsp = (
      await request(app)
        .post('/api/accounts')
        .send({ label: 'RRSP', roomLimitCents: 8_790_100 })
        .expect(201)
    ).body.accounts.at(-1).id as string;
    const tfsa = (
      await request(app)
        .post('/api/accounts')
        .send({ label: 'TFSA', roomLimitCents: 3_220_085 })
        .expect(201)
    ).body.accounts.at(-1).id as string;

    const mkSleeve = async (accountId: string, label: string, targetBps: number) =>
      (
        await request(app)
          .post('/api/sleeves')
          .send({ accountId, label, targetBps })
          .expect(201)
      ).body.sleeves.at(-1).id as string;

    const rrspStock = await mkSleeve(rrsp, 'RRSP stock', 4500);
    const rrspBonds = await mkSleeve(rrsp, 'RRSP bonds', 1000);
    const tfsaStock = await mkSleeve(tfsa, 'TFSA stock', 4500);

    const mkAsset = (sleeveId: string, ticker: string) =>
      request(app).post('/api/assets').send({ sleeveId, ticker, weightBps: 10_000 }).expect(201);
    await mkAsset(rrspStock, 'XEQT');
    await mkAsset(rrspBonds, 'ZAG');
    await mkAsset(tfsaStock, 'XEQT');

    return { rrsp, tfsa };
  }

  beforeEach(async () => {
    await db.reset(); // drop the example portfolio loaded by the outer beforeEach
  });

  it('redirects TFSA overflow into the RRSP XEQT sleeve and persists it', async () => {
    const { tfsa } = await buildSharedTickerPortfolio();

    const { body } = await request(app)
      .post('/api/invest')
      .send({ amountCents: 10_000_000, prioritizedAccountIds: [tfsa] })
      .expect(200);

    const plan = body.plan as AllocationPlan;
    expect(plan.redirectedCents).toBe(1_279_915);
    expect(plan.unallocatedCents).toBe(0);

    const holdings = await db.pool.query(
      `SELECT a.ticker, s.label, a.holding_cents::int AS cents
         FROM assets a JOIN sleeves s ON s.id = a.sleeve_id
        ORDER BY s.label`,
    );
    const byLabel = Object.fromEntries(holdings.rows.map((r) => [r.label, r.cents]));
    expect(byLabel['RRSP stock']).toBe(5_779_915);
    expect(byLabel['RRSP bonds']).toBe(1_000_000);
    expect(byLabel['TFSA stock']).toBe(3_220_085);
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm vitest run server/api.test.ts -t "prioritiz"`
Expected: FAIL — the schema strips the unknown field so `prioritizedAccountIds` is `undefined` on the plan; the unknown-id case returns 200; the redirect case does not redirect.

- [ ] **Step 3: Add `prioritizedAccountIds` to `depositSchema`**

In `server/app.ts`, extend `depositSchema`:

```ts
const depositSchema = z.object({
  amountCents: z
    .number()
    .int('amount must be a whole number of cents')
    .positive('enter an amount greater than zero'),
  label: z.string().trim().max(60, 'label is too long').optional().default(''),
  prioritizedAccountIds: z.array(idSchema).max(MAX_ACCOUNTS).optional().default([]),
});
```

- [ ] **Step 4: Add the unknown-account guard and thread the argument**

In `server/app.ts`, add `PortfolioState` to the type import from `../shared/types`:

```ts
import type { InvestmentRecord, PortfolioState } from '../shared/types';
```

Add this helper next to `formatCentsForMessage` (module scope, above `createApp`):

```ts
/** Rejects a deposit that names a prioritized account the portfolio doesn't have. */
function assertKnownPrioritized(portfolio: PortfolioState, ids: string[]): void {
  const known = new Set(portfolio.accounts.map((a) => a.id));
  const unknown = ids.find((id) => !known.has(id));
  if (unknown) {
    throw new HttpError(400, `unknown account in prioritizedAccountIds: ${unknown}`);
  }
}
```

Rewrite the `/api/preview` handler body:

```ts
  app.post(
    '/api/preview',
    route(async (req, res) => {
      const { amountCents, prioritizedAccountIds } = depositSchema.parse(req.body);
      const portfolio = await readPortfolio(db);
      const issue = allocationIssues(portfolio)[0];
      if (issue) throw new HttpError(400, issue.message);
      assertKnownPrioritized(portfolio, prioritizedAccountIds);
      res.json(
        planDeposit(
          toRebalanceUnits(portfolio),
          portfolio.accounts,
          amountCents,
          prioritizedAccountIds,
        ),
      );
    }),
  );
```

In the `/api/invest` handler: change the destructure to
`const { amountCents, label, prioritizedAccountIds } = depositSchema.parse(req.body);`,
and inside the transaction, after the `allocationIssues` check, add
`assertKnownPrioritized(portfolio, prioritizedAccountIds);` then change the plan line to:

```ts
        const plan = planDeposit(
          toRebalanceUnits(portfolio),
          portfolio.accounts,
          amountCents,
          prioritizedAccountIds,
        );
```

- [ ] **Step 5: Run the API suite**

Run: `pnpm vitest run server/api.test.ts && pnpm typecheck`
Expected: PASS — new cases green; all existing `/api/invest` and `/api/preview` cases unchanged.

- [ ] **Step 6: Commit**

```bash
git add server/app.ts server/api.test.ts
git commit -m "API: accept and validate prioritizedAccountIds on preview and invest"
```

---

### Task 4: Client — prioritize control in the Plan view

**Files:**
- Modify: `src/lib/api.ts` (`preview` ~line 44-48, `invest` ~line 50-54)
- Modify: `src/App.tsx` (imports, state ~line 20-40, `preview` memo ~line 66-69, `invest` ~line 71-92, the invest `<form>` and messaging ~line 178-267)

**Interfaces:**
- Consumes: `AllocationPlan.prioritizedAccountIds`, `AllocationPlan.redirectedCents`, `AllocationLine.redirectedCents`, `AllocationLine.blockedCents` (Task 2); the API's new body field (Task 3).
- Produces: no exports other tasks depend on. `api.preview(amountCents, prioritizedAccountIds?)` and `api.invest(amountCents, label?, prioritizedAccountIds?)` gain a trailing optional argument.

> **Testing note:** this repo has no React render tests by design (see README "Tests" — component logic is covered directly in `shared/` and `server/`). This task is verified by `pnpm typecheck && pnpm lint && pnpm build` plus the manual smoke check in Step 6. Do not add a React test harness.

- [ ] **Step 1: Thread the argument through the API client**

In `src/lib/api.ts`, replace the `preview` and `invest` entries:

```ts
  preview: (amountCents: number, prioritizedAccountIds: string[] = []) =>
    request<AllocationPlan>('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ amountCents, prioritizedAccountIds }),
    }),

  invest: (amountCents: number, label?: string, prioritizedAccountIds: string[] = []) =>
    request<InvestResult>('/api/invest', {
      method: 'POST',
      body: JSON.stringify({ amountCents, label, prioritizedAccountIds }),
    }),
```

- [ ] **Step 2: Add state and the derived active-priority list in `src/App.tsx`**

Add the dropdown-menu imports next to the other UI imports:

```ts
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
```

After the `label` state declaration, add:

```ts
  const [prioritizedAccountIds, setPrioritizedAccountIds] = useState<string[]>([]);
```

After `portfolio` is known to be non-null (just before `const shown = ...` near the end, where `exhaustedAccounts` is computed), add:

```ts
  const prioritizableAccounts = portfolio.accounts.filter((a) => a.roomRemainingCents !== null);
  // Ignore any stale id whose account lost its room limit since it was picked.
  const activePriorities = prioritizedAccountIds.filter((id) =>
    prioritizableAccounts.some((a) => a.id === id),
  );
  const togglePriority = (id: string) =>
    setPrioritizedAccountIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
```

- [ ] **Step 3: Feed the priorities into the preview and the invest call**

Change the `preview` memo to pass and depend on `activePriorities`:

```ts
  const preview = useMemo(() => {
    if (!portfolio || parsed.cents === null || flight || issues.length > 0) return null;
    return planDeposit(
      toRebalanceUnits(portfolio),
      portfolio.accounts,
      parsed.cents,
      activePriorities,
    );
  }, [portfolio, parsed.cents, flight, issues, activePriorities]);
```

> `activePriorities` is a fresh array each render; that is fine here — the memo already recomputes whenever `parsed.cents` or `portfolio` changes, and an extra recompute on an unrelated render is cheap for ≤10 accounts. If lint flags the dependency, wrap `activePriorities` in its own `useMemo` keyed on `[prioritizedAccountIds, portfolio.accounts]`.

In `invest()`, change the API call:

```ts
      const result = await api.invest(parsed.cents, label, activePriorities);
```

- [ ] **Step 4: Render the control inside the invest form**

In the `<form>`, after the Label field's closing `</div>` and before the submit `<Button>`, add:

```tsx
              {prioritizableAccounts.length > 0 && (
                <div className="min-w-56 space-y-1.5">
                  <span className="text-sm font-medium">Prioritize filling</span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="outline" className="w-full justify-between">
                        {activePriorities.length === 0
                          ? 'No priority'
                          : activePriorities
                              .map(
                                (id) =>
                                  portfolio.accounts.find((a) => a.id === id)?.label ?? id,
                              )
                              .join(', ')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      <DropdownMenuLabel>Fill to contribution room first</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {prioritizableAccounts.map((account) => (
                        <DropdownMenuCheckboxItem
                          key={account.id}
                          checked={activePriorities.includes(account.id)}
                          onCheckedChange={() => togglePriority(account.id)}
                          onSelect={(event) => event.preventDefault()}
                        >
                          {account.label}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
```

- [ ] **Step 5: Add the redirect / no-home messaging**

Immediately after the existing `{shown && shown.unallocatedCents > 0 && ( ... )}` block, add:

```tsx
            {preview && preview.redirectedCents > 0 && (
              <p className="text-sm text-muted-foreground">
                Filling{' '}
                {preview.prioritizedAccountIds
                  .map((id) => portfolio.accounts.find((a) => a.id === id)?.label ?? id)
                  .join(' and ')}{' '}
                to contribution room first — {formatCents(preview.redirectedCents)} redirected to{' '}
                {[
                  ...new Set(
                    preview.lines
                      .filter((line) => line.redirectedCents > 0)
                      .map(
                        (line) =>
                          portfolio.accounts.find((a) => a.id === line.accountId)?.label ??
                          line.accountId,
                      ),
                  ),
                ].join(' and ')}{' '}
                to keep your asset mix.
              </p>
            )}

            {preview &&
              preview.lines
                .filter(
                  (line) =>
                    line.blockedCents > 0 &&
                    line.redirectedCents === 0 &&
                    preview.prioritizedAccountIds.includes(line.accountId),
                )
                .map((line) => {
                  const ticker = portfolio.sleeves
                    .flatMap((s) => s.assets)
                    .find((a) => a.id === line.assetId)?.ticker;
                  const accountLabel =
                    portfolio.accounts.find((a) => a.id === line.accountId)?.label ?? line.accountId;
                  return (
                    <p key={line.assetId} className="text-sm text-destructive">
                      {formatCents(line.blockedCents)} from {accountLabel} couldn&apos;t be
                      redirected — no other sleeve holds {ticker ?? 'that ticker'} — and stays as
                      cash.
                    </p>
                  );
                })}
```

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass.

Then manual smoke — `pnpm dev`, open the web app, **Load example portfolio**, go to **Edit**, set RRSP contribution room to `87901` and TFSA to `32200.85`, add a second sleeve? Not needed — the example tickers are distinct, so to see a *redirect* rename assets: set TFSA's "Canadian equity" asset ticker to `XEQT` and RRSP's "US total market" asset ticker to `XEQT`. Back in **Plan**, type `100000`, open **Prioritize filling**, check **TFSA**. Confirm the diagram shows TFSA's XEQT sleeve at its room and the extra landing in RRSP's XEQT sleeve, and the "redirected … to keep your asset mix" line appears. Uncheck it — the split returns to the plain drift allocation.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/App.tsx
git commit -m "Plan view: choose accounts to fill to contribution room first"
```

---

### Task 5: Document prioritization in the README

**Files:**
- Modify: `README.md` ("How deposits are split" section, ~line 39-57)

**Interfaces:** none.

- [ ] **Step 1: Add the prioritization subsection**

In `README.md`, after the "**Contribution room caps, and does not redirect.**" paragraph and before the "All money is handled as integer cents…" line, insert:

```markdown
**Prioritizing an account.** When you plan a deposit you can mark one or more
accounts as *prioritized*. A prioritized account is filled toward its normal
drift-aware target first, but never past its remaining contribution room. Cents
that would have gone in beyond that room are **redirected to other sleeves holding
the same ticker**, so the stock/bond mix stays put — they are not spread across
every sleeve. Overflow with no same-ticker home, and any redirect that would push
a receiving account past *its* room, falls back to unallocated cash. The choice is
per-deposit and changes nothing that is stored.
```

- [ ] **Step 2: Verify the surrounding text still reads correctly**

Run: `git diff README.md`
Expected: the new paragraph sits between the contribution-room paragraph and the integer-cents paragraph; nothing else changed.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: document per-deposit account prioritization"
```

---

## Self-Review

**1. Spec coverage**

| Spec section | Task |
| --- | --- |
| Part 1 — engine signature, `RebalanceUnit.ticker` | Task 1 |
| Part 1 — Phase 1/2/3/4 algorithm | Task 2, Step 4 |
| Part 1 — cent-exactness, `Σ redirectedCents === 0` | Task 2, Steps 2/6/7 |
| Part 2 — `AllocationLine.redirectedCents`, redefined `blockedCents`, identity | Task 2, Step 1 |
| Part 2 — `AllocationPlan.prioritizedAccountIds`, `redirectedCents`, widened `cappedAccountIds` | Task 2, Step 1 + Step 4 |
| Part 3 — `depositSchema` field, both routes, 400 on unknown id, history unchanged, `api.ts` args | Task 3 (routes/schema/validation), Task 4 Step 1 (`api.ts`) |
| Part 4 — Plan-view control (finite-room accounts only, hidden when none), wiring, messaging, no diagram change | Task 4 |
| Part 5 — engine tests | Task 2, Steps 2/6/7 |
| Part 5 — API tests | Task 3, Step 1 |
| Part 5 — `toRebalanceUnits` carries ticker | Task 1, Step 1 |
| Part 6 — edge cases 1-8 | 1&7 → Task 2 Step 6 (no-op cases) & Step 6 (`is a no-op when it fits`); 2 → Task 2 Step 6 (`holds overflow as cash`); 3 → Task 2 Step 6 (`redirected cents that overflow`); 4 → covered by two-prioritized case + Phase 3; 5 → Task 3 Step 1 (unknown id 400); 6 → Task 2 Step 4 (remaining-need weighting) exercised by two-prioritized case; 8 → Task 2 Step 7 invariants |
| Part 7 — non-goals | No schema change (Global Constraints); no ranking (peers in Task 2); choice not persisted (Task 3 leaves `investment_lines` alone); no diagram styling (Task 4 note) |

No gaps.

**2. Placeholder scan**

No "TBD"/"handle edge cases"/"similar to Task N"/"write tests for the above" — every code and test step carries literal content. The manual smoke check in Task 4 Step 6 is spelled out click-by-click.

**3. Type consistency**

- `planDeposit` 4th parameter: `prioritizedAccountIds: readonly string[] = []` in Task 2 Step 4; callers pass `string[]` (Task 3, Task 4) — assignable to `readonly string[]`. ✔
- `AllocationPlan.prioritizedAccountIds: string[]` / `redirectedCents: number` — defined Task 2 Step 1, read in Task 3 tests and Task 4 messaging with those types. ✔
- `AllocationLine.redirectedCents: number` — defined Task 2 Step 1, read in Task 2/3 tests and Task 4. ✔
- `assertKnownPrioritized(portfolio: PortfolioState, ids: string[])` — defined and called in Task 3 only. ✔
- `api.preview(amountCents, prioritizedAccountIds?)` / `api.invest(amountCents, label?, prioritizedAccountIds?)` — signature set in Task 4 Step 1, used in Task 4 Step 3. ✔
- `activePriorities` / `prioritizableAccounts` / `togglePriority` — all defined in Task 4 Step 2, used in Steps 3-5. ✔
- `RebalanceUnit.ticker: string` — added Task 1, consumed in Task 2 Step 4 (`units[i].ticker`) and populated by `toRebalanceUnits` / the `unit` test helper. ✔

No mismatches found.
