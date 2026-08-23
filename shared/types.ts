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
  sortOrder: number;
}

export interface Sleeve {
  id: string;
  accountId: string;
  tickers: string;
  label: string;
  /** Target share of the total portfolio, in basis points. All sleeves sum to 10000. */
  targetBps: number;
  holdingCents: number;
  /** Actual share of the current portfolio, in basis points. 0 when the portfolio is empty. */
  actualBps: number;
  /** `actualBps - targetBps`. Negative means underweight, so deposits flow here first. */
  driftBps: number;
  sortOrder: number;
}

export interface PortfolioState {
  accounts: Account[];
  sleeves: Sleeve[];
  totalCents: number;
}

export interface AllocationLine {
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
  requestedCents: number;
  allocatedCents: number;
  unallocatedCents: number;
  createdAt: string;
  lines: { sleeveId: string; intendedCents: number; amountCents: number }[];
}
