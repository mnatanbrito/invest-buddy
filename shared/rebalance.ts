import type { AllocationLine, AllocationPlan } from './types';

const BPS = 10_000n;

/** Scale of `RebalanceUnit.targetWeight`: sleeve.targetBps * asset.weightBps. */
export const WEIGHT_SCALE = BPS * BPS; // 100_000_000

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

export interface RebalanceAccount {
  id: string;
  /** Remaining contribution room in cents, or `null` for unlimited. */
  roomRemainingCents: number | null;
}

/**
 * Split `total` across `weights` proportionally, in exact integers.
 *
 * Uses the largest-remainder method so the parts always sum to exactly `total`
 * with no cent lost or invented. Arithmetic is BigInt because the intermediate
 * `weight * total` products overflow IEEE-754 well before the amounts do.
 */
export function apportion(weights: bigint[], total: bigint): bigint[] {
  const sumWeights = weights.reduce((a, b) => a + b, 0n);
  if (sumWeights <= 0n || total <= 0n) return weights.map(() => 0n);

  const parts = weights.map((w) => (w * total) / sumWeights);
  const remainders = weights.map((w, i) => w * total - parts[i] * sumWeights);

  // Hand out the cents lost to truncation, largest fractional remainder first.
  let leftover = total - parts.reduce((a, b) => a + b, 0n);
  const byRemainder = remainders
    .map((r, i) => ({ i, r }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));

  for (let k = 0; leftover > 0n && k < byRemainder.length; k++, leftover--) {
    parts[byRemainder[k].i] += 1n;
  }
  return parts;
}

/**
 * Drift-aware cash-flow rebalancing: work out where a deposit should go so the
 * portfolio moves back toward its target weights, without ever selling.
 *
 * For each unit, "need" is how far below its target it would sit once the
 * deposit lands: `targetWeight * totalAfter - holding * WEIGHT_SCALE`, clamped
 * at zero so overweight units get nothing. Those needs become the apportionment
 * weights.
 *
 * The two cases fall out of the same formula. When no unit is overweight the
 * needs sum to exactly `WEIGHT_SCALE * deposit`, so each unit receives precisely
 * what it needs and the portfolio lands on target. When some unit is overweight
 * the needs sum to more than the deposit can cover, so every underweight unit
 * gets a proportional share of the shortfall instead.
 */
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

/** Actual share of the portfolio held by `holdingCents`, in basis points. */
export function actualBps(holdingCents: number, totalCents: number): number {
  if (totalCents <= 0) return 0;
  return Number((BigInt(holdingCents) * BPS) / BigInt(totalCents));
}

/** sleeve.targetBps * asset.weightBps, on the WEIGHT_SCALE. Exact — no rounding. */
export function effectiveWeight(sleeveTargetBps: number, assetWeightBps: number): number {
  return sleeveTargetBps * assetWeightBps;
}

/** Display-only share of the whole portfolio an asset targets, in basis points. Floored. */
export function effectiveTargetBps(sleeveTargetBps: number, assetWeightBps: number): number {
  return Math.floor((sleeveTargetBps * assetWeightBps) / 10_000);
}
