import type { PoolClient } from 'pg';
import { actualBps } from '../shared/rebalance';
import type { Account, PortfolioState, Sleeve } from '../shared/types';

interface AccountRow {
  id: string;
  label: string;
  note: string;
  room_limit: number | null;
  sort_order: number;
  room_used: number;
}

interface SleeveRow {
  id: string;
  account_id: string;
  tickers: string;
  label: string;
  target_bps: number;
  holding_cents: number;
  sort_order: number;
}

/**
 * Contribution room used is derived from the investment ledger rather than stored,
 * so undoing an investment gives the room back with no extra bookkeeping.
 */
const ACCOUNTS_QUERY = `
  SELECT a.id, a.label, a.note, a.room_limit, a.sort_order,
         COALESCE(used.total, 0)::BIGINT AS room_used
    FROM accounts a
    LEFT JOIN (
      SELECT s.account_id, SUM(l.amount_cents)::BIGINT AS total
        FROM investment_lines l
        JOIN sleeves s ON s.id = l.sleeve_id
       GROUP BY s.account_id
    ) used ON used.account_id = a.id
   ORDER BY a.sort_order
`;

export async function readPortfolio(client: PoolClient): Promise<PortfolioState> {
  const [accountsResult, sleevesResult] = await Promise.all([
    client.query<AccountRow>(ACCOUNTS_QUERY),
    client.query<SleeveRow>('SELECT * FROM sleeves ORDER BY sort_order'),
  ]);

  const accounts: Account[] = accountsResult.rows.map((row) => ({
    id: row.id,
    label: row.label,
    note: row.note,
    roomLimitCents: row.room_limit,
    roomUsedCents: row.room_used,
    roomRemainingCents: row.room_limit === null ? null : Math.max(0, row.room_limit - row.room_used),
    sortOrder: row.sort_order,
  }));

  const totalCents = sleevesResult.rows.reduce((sum, row) => sum + row.holding_cents, 0);

  const sleeves: Sleeve[] = sleevesResult.rows.map((row) => {
    const actual = actualBps(row.holding_cents, totalCents);
    return {
      id: row.id,
      accountId: row.account_id,
      tickers: row.tickers,
      label: row.label,
      targetBps: row.target_bps,
      holdingCents: row.holding_cents,
      actualBps: actual,
      driftBps: totalCents > 0 ? actual - row.target_bps : 0,
      sortOrder: row.sort_order,
    };
  });

  return { accounts, sleeves, totalCents };
}
