import { describe, expect, it } from 'vitest';
import {
  allocationIssues,
  assetWeightTotalBps,
  isFullyAllocated,
  sleeveTargetTotalBps,
  toRebalanceUnits,
} from './allocation';
import type { Account, Asset, PortfolioState, Sleeve } from './types';

const account = (id: string, sortOrder: number): Account => ({
  id,
  label: id,
  note: '',
  roomLimitCents: null,
  roomUsedCents: 0,
  roomRemainingCents: null,
  holdingCents: 0,
  sortOrder,
});

const asset = (id: string, sleeveId: string, weightBps: number): Asset => ({
  id,
  sleeveId,
  ticker: id,
  label: '',
  weightBps,
  holdingCents: 0,
  effectiveTargetBps: 0,
  actualBps: 0,
  driftBps: 0,
  sortOrder: 1,
});

const sleeve = (id: string, accountId: string, targetBps: number, assets: Asset[]): Sleeve => ({
  id,
  accountId,
  label: id,
  targetBps,
  sortOrder: 1,
  assets,
  holdingCents: 0,
  actualBps: 0,
  driftBps: 0,
  assetWeightTotalBps: assets.reduce((sum, a) => sum + a.weightBps, 0),
});

const portfolio = (accounts: Account[], sleeves: Sleeve[]): PortfolioState => ({
  accounts,
  sleeves,
  totalCents: 0,
});

describe('sleeveTargetTotalBps', () => {
  it('sums sleeve targets across every account', () => {
    const sleeves = [sleeve('a', 'acct', 4500, []), sleeve('b', 'acct', 5500, [])];
    expect(sleeveTargetTotalBps(sleeves)).toBe(10_000);
  });
});

describe('assetWeightTotalBps', () => {
  it('sums asset weights within a sleeve', () => {
    expect(assetWeightTotalBps([asset('a', 's', 7000), asset('b', 's', 3000)])).toBe(10_000);
  });
});

describe('allocationIssues', () => {
  it('flags an empty portfolio first', () => {
    const issues = allocationIssues(portfolio([], []));
    expect(issues).toEqual([{ kind: 'no-accounts', message: expect.any(String) }]);
  });

  it('flags sleeve targets that do not sum to 10000', () => {
    const accounts = [account('acct', 1)];
    const sleeves = [sleeve('a', 'acct', 4000, [asset('x', 'a', 10_000)])];
    const issues = allocationIssues(portfolio(accounts, sleeves));
    expect(issues).toEqual([{ kind: 'sleeve-targets', totalBps: 4000, message: expect.any(String) }]);
  });

  it('flags a sleeve whose assets do not sum to 10000, including zero-asset sleeves', () => {
    const accounts = [account('acct', 1)];
    const sleeves = [sleeve('a', 'acct', 10_000, [])];
    const issues = allocationIssues(portfolio(accounts, sleeves));
    expect(issues).toEqual([
      { kind: 'sleeve-assets', sleeveId: 'a', totalBps: 0, message: expect.any(String) },
    ]);
  });

  it('reports no issues once fully allocated', () => {
    const accounts = [account('acct', 1)];
    const sleeves = [sleeve('a', 'acct', 10_000, [asset('x', 'a', 10_000)])];
    const p = portfolio(accounts, sleeves);
    expect(allocationIssues(p)).toEqual([]);
    expect(isFullyAllocated(p)).toBe(true);
  });
});

describe('toRebalanceUnits', () => {
  it('flattens sleeves and assets into rebalance units with effective weight', () => {
    const accounts = [account('acct', 1)];
    const sleeves = [sleeve('a', 'acct', 4500, [asset('x', 'a', 7000), asset('y', 'a', 3000)])];
    const units = toRebalanceUnits(portfolio(accounts, sleeves));

    expect(units).toEqual([
      { id: 'x', sleeveId: 'a', accountId: 'acct', targetWeight: 4500 * 7000, holdingCents: 0 },
      { id: 'y', sleeveId: 'a', accountId: 'acct', targetWeight: 4500 * 3000, holdingCents: 0 },
    ]);
  });
});
