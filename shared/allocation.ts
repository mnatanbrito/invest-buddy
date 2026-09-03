import { effectiveWeight, type RebalanceUnit } from './rebalance';
import type { Asset, PortfolioState, Sleeve } from './types';

export const MAX_ACCOUNTS = 10;
export const MAX_SLEEVES = 10;
export const MAX_ASSETS_PER_SLEEVE = 10;

export function sleeveTargetTotalBps(sleeves: Sleeve[]): number {
  return sleeves.reduce((sum, sleeve) => sum + sleeve.targetBps, 0);
}

export function assetWeightTotalBps(assets: Pick<Asset, 'weightBps'>[]): number {
  return assets.reduce((sum, asset) => sum + asset.weightBps, 0);
}

export type AllocationIssue =
  | { kind: 'no-accounts'; message: string }
  | { kind: 'sleeve-targets'; totalBps: number; message: string }
  | { kind: 'sleeve-assets'; sleeveId: string; totalBps: number; message: string };

/**
 * What's stopping this portfolio from being ready to invest into, in priority
 * order: no accounts at all, then sleeve targets not summing to 100%, then any
 * one sleeve whose asset weights don't sum to 100% (a zero-asset sleeve included,
 * since it sums to 0).
 */
export function allocationIssues(portfolio: PortfolioState): AllocationIssue[] {
  const issues: AllocationIssue[] = [];

  if (portfolio.accounts.length === 0) {
    issues.push({ kind: 'no-accounts', message: 'Add at least one account to get started.' });
    return issues;
  }

  const targetTotal = sleeveTargetTotalBps(portfolio.sleeves);
  if (targetTotal !== 10_000) {
    issues.push({
      kind: 'sleeve-targets',
      totalBps: targetTotal,
      message: `Sleeve targets add up to ${(targetTotal / 100).toFixed(1)}%, not 100%.`,
    });
  }

  for (const sleeve of portfolio.sleeves) {
    const total = sleeve.assetWeightTotalBps;
    if (total !== 10_000) {
      issues.push({
        kind: 'sleeve-assets',
        sleeveId: sleeve.id,
        totalBps: total,
        message: `${sleeve.label} assets add up to ${(total / 100).toFixed(1)}%, not 100%.`,
      });
    }
  }

  return issues;
}

export function isFullyAllocated(portfolio: PortfolioState): boolean {
  return allocationIssues(portfolio).length === 0;
}

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
