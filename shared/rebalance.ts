import type { AllocationLine, AllocationPlan } from './types';

const BPS = 10_000n;

/** Scale of `RebalanceUnit.targetWeight`: sleeve.targetBps * asset.weightBps. */
export const WEIGHT_SCALE = BPS * BPS; // 100_000_000

export interface RebalanceUnit {
  /** assetId */
  id: string;
  sleeveId: string;
  accountId: string;
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
): AllocationPlan {
  if (!Number.isInteger(depositCents) || depositCents <= 0) {
    throw new RangeError(`deposit must be a positive whole number of cents, got ${depositCents}`);
  }

  const deposit = BigInt(depositCents);
  const totalHoldings = units.reduce((sum, u) => sum + BigInt(u.holdingCents), 0n);
  const totalAfter = totalHoldings + deposit;

  const needs = units.map((u) => {
    const shortfall = BigInt(u.targetWeight) * totalAfter - BigInt(u.holdingCents) * WEIGHT_SCALE;
    return shortfall > 0n ? shortfall : 0n;
  });

  const intended = apportion(needs, deposit);

  // Cap each registered account at its remaining contribution room. The blocked
  // remainder is NOT redirected elsewhere; it comes back as unallocated cash.
  const amounts = intended.slice();
  const cappedAccountIds: string[] = [];

  for (const account of accounts) {
    if (account.roomRemainingCents === null) continue;

    const room = BigInt(Math.max(0, account.roomRemainingCents));
    const indices = units.flatMap((u, i) => (u.accountId === account.id ? [i] : []));
    const wanted = indices.reduce((sum, i) => sum + intended[i], 0n);
    if (wanted <= room) continue;

    const fitted = apportion(
      indices.map((i) => intended[i]),
      room,
    );
    indices.forEach((i, k) => {
      amounts[i] = fitted[k];
    });
    cappedAccountIds.push(account.id);
  }

  const lines: AllocationLine[] = units.map((u, i) => ({
    assetId: u.id,
    sleeveId: u.sleeveId,
    accountId: u.accountId,
    intendedCents: Number(intended[i]),
    amountCents: Number(amounts[i]),
    blockedCents: Number(intended[i] - amounts[i]),
  }));

  const allocatedCents = lines.reduce((sum, l) => sum + l.amountCents, 0);

  return {
    requestedCents: depositCents,
    allocatedCents,
    unallocatedCents: depositCents - allocatedCents,
    lines,
    cappedAccountIds,
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
