/** Shared contracts between the API and the client. All money is integer cents. */

export interface Account {
  id: string;
  label: string;
  note: string;
  /** Total CRA contribution room, in cents. `null` means unlimited (non-registered). */
  roomLimitCents: number | null;
  /** Cents already contributed to this account through recorded investments. */
  roomUsedCents: number;
  /** `roomLimitCents - roomUsedCents`, floored at 0. `null` when unlimited. */
  roomRemainingCents: number | null;
  /** Sum of this account's descendant asset holdings. */
  holdingCents: number;
  sortOrder: number;
}

export interface Asset {
  id: string;
  sleeveId: string;
  ticker: string;
  label: string;
  /** Target share of the parent sleeve, in basis points. A sleeve's assets sum to 10000. */
  weightBps: number;
  holdingCents: number;
  /** Display-only: floor(sleeve.targetBps * weightBps / 10000). */
  effectiveTargetBps: number;
  /** Actual share of the whole portfolio, in basis points. 0 when the portfolio is empty. */
  actualBps: number;
  /** `actualBps - effectiveTargetBps`. Negative means underweight. */
  driftBps: number;
  sortOrder: number;
}

export interface Sleeve {
  id: string;
  accountId: string;
  label: string;
  /** Target share of the total portfolio, in basis points. All sleeves sum to 10000. */
  targetBps: number;
  sortOrder: number;
  /** Ordered by sortOrder. */
  assets: Asset[];
  /** Sum of this sleeve's asset holdings. */
  holdingCents: number;
  /** Actual share of the whole portfolio, in basis points. */
  actualBps: number;
  /** `actualBps - targetBps`. */
  driftBps: number;
  /** Sum of assets[].weightBps. Should be 10000 once fully allocated. */
  assetWeightTotalBps: number;
}

export interface PortfolioState {
  accounts: Account[];
  /** Flat, with nested assets; ordered by sortOrder. */
  sleeves: Sleeve[];
  totalCents: number;
}

export interface AllocationLine {
  /** The unit of allocation. */
  assetId: string;
  /** Derived, for display grouping. */
  sleeveId: string;
  accountId: string;
  /** What the rebalancer wanted to put here, before contribution-room capping. */
  intendedCents: number;
  /** What actually goes in. */
  amountCents: number;
  /** `intendedCents - amountCents`: blocked by contribution room. */
  blockedCents: number;
}

export interface AllocationPlan {
  requestedCents: number;
  allocatedCents: number;
  /** Requested minus allocated: held back as cash because room ran out. */
  unallocatedCents: number;
  lines: AllocationLine[];
  /** Ids of accounts whose contribution room capped this deposit. */
  cappedAccountIds: string[];
}

export interface InvestmentRecord {
  id: number;
  label: string;
  requestedCents: number;
  allocatedCents: number;
  unallocatedCents: number;
  createdAt: string;
  lines: { assetId: string; sleeveId: string; intendedCents: number; amountCents: number }[];
}
