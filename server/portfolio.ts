import type { PoolClient } from 'pg';
import { actualBps, effectiveTargetBps } from '../shared/rebalance';
import type { Account, Asset, PortfolioState, Sleeve } from '../shared/types';

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
  label: string;
  target_bps: number;
  sort_order: number;
}

interface AssetRow {
  id: string;
  sleeve_id: string;
  ticker: string;
  label: string;
  weight_bps: number;
  holding_cents: number;
  sort_order: number;
}

/**
 * Contribution room used is derived from the investment ledger rather than stored,
 * so undoing an investment gives the room back with no extra bookkeeping. Joined
 * through assets -> sleeves since holdings live on assets now.
 */
const ACCOUNTS_QUERY = `
  SELECT a.id, a.label, a.note, a.room_limit, a.sort_order,
         COALESCE(used.total, 0)::BIGINT AS room_used
    FROM accounts a
    LEFT JOIN (
      SELECT s.account_id, SUM(l.amount_cents)::BIGINT AS total
        FROM investment_lines l
        JOIN assets ast ON ast.id = l.asset_id
        JOIN sleeves s ON s.id = ast.sleeve_id
       GROUP BY s.account_id
    ) used ON used.account_id = a.id
   ORDER BY a.sort_order, a.id
`;

/** Sleeves ordered through their parent account first, so the flat list stays grouped by account. */
const SLEEVES_QUERY = `
  SELECT s.id, s.account_id, s.label, s.target_bps, s.sort_order
    FROM sleeves s
    JOIN accounts a ON a.id = s.account_id
   ORDER BY a.sort_order, a.id, s.sort_order, s.id
`;

/** Assets ordered through their parent sleeve and account, so the flat list stays grouped. */
const ASSETS_QUERY = `
  SELECT ast.id, ast.sleeve_id, ast.ticker, ast.label, ast.weight_bps, ast.holding_cents, ast.sort_order
    FROM assets ast
    JOIN sleeves s ON s.id = ast.sleeve_id
    JOIN accounts a ON a.id = s.account_id
   ORDER BY a.sort_order, a.id, s.sort_order, s.id, ast.sort_order, ast.id
`;

export type EntityKind = 'account' | 'sleeve' | 'asset';

export interface DeleteBlock {
  holdingCents: number;
  hasHistory: boolean;
}

const DELETE_BLOCKERS_SCOPE: Record<EntityKind, string> = {
  account: `EXISTS (SELECT 1 FROM sleeves s WHERE s.account_id = $1 AND s.id = ast.sleeve_id)`,
  sleeve: `ast.sleeve_id = $1`,
  asset: `ast.id = $1`,
};

/** What would stop `id` (of kind `kind`) from being deleted. */
export async function deleteBlockers(
  client: PoolClient,
  kind: EntityKind,
  id: string,
): Promise<DeleteBlock> {
  const scope = DELETE_BLOCKERS_SCOPE[kind];
  const { rows } = await client.query<{ holding_cents: number; has_history: boolean }>(
    `SELECT
       COALESCE((SELECT SUM(ast.holding_cents) FROM assets ast WHERE ${scope}), 0)::BIGINT AS holding_cents,
       EXISTS (
         SELECT 1 FROM investment_lines l JOIN assets ast ON ast.id = l.asset_id WHERE ${scope}
       ) AS has_history`,
    [id],
  );
  return { holdingCents: rows[0].holding_cents, hasHistory: rows[0].has_history };
}

const SORT_ORDER_TABLES = {
  accounts: { parentColumn: null },
  sleeves: { parentColumn: 'account_id' },
  assets: { parentColumn: 'sleeve_id' },
} as const;

export type SortableTable = keyof typeof SORT_ORDER_TABLES;

/** Next sort_order for a new row: one past the current max within its parent scope. */
export async function nextSortOrder(
  client: PoolClient,
  table: SortableTable,
  parentId: string | null,
): Promise<number> {
  const { parentColumn } = SORT_ORDER_TABLES[table];
  const where = parentColumn && parentId !== null ? `WHERE ${parentColumn} = $1` : '';
  const params = parentColumn && parentId !== null ? [parentId] : [];
  const { rows } = await client.query<{ next: number }>(
    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM ${table} ${where}`,
    params,
  );
  return rows[0].next;
}

/** Update an entity's sort_order to a new position. */
export async function resequence(
  client: PoolClient,
  table: SortableTable,
  id: string,
  sortOrder: number,
): Promise<void> {
  await client.query(`UPDATE ${table} SET sort_order = $1 WHERE id = $2`, [sortOrder, id]);
}

export async function readPortfolio(client: PoolClient): Promise<PortfolioState> {
  // Sequential, not Promise.all: concurrent queries on a single pg PoolClient are
  // deprecated (removed in pg@9), and a single Postgres connection serializes them
  // anyway, so there's no concurrency to gain.
  const accountsResult = await client.query<AccountRow>(ACCOUNTS_QUERY);
  const sleevesResult = await client.query<SleeveRow>(SLEEVES_QUERY);
  const assetsResult = await client.query<AssetRow>(ASSETS_QUERY);

  const totalCents = assetsResult.rows.reduce((sum, row) => sum + row.holding_cents, 0);

  const assetsBySleeve = new Map<string, AssetRow[]>();
  for (const row of assetsResult.rows) {
    const list = assetsBySleeve.get(row.sleeve_id) ?? [];
    list.push(row);
    assetsBySleeve.set(row.sleeve_id, list);
  }

  const sleeves: Sleeve[] = sleevesResult.rows.map((sleeveRow) => {
    const assetRows = assetsBySleeve.get(sleeveRow.id) ?? [];
    const assets: Asset[] = assetRows.map((row) => {
      const actual = actualBps(row.holding_cents, totalCents);
      const effectiveTarget = effectiveTargetBps(sleeveRow.target_bps, row.weight_bps);
      return {
        id: row.id,
        sleeveId: row.sleeve_id,
        ticker: row.ticker,
        label: row.label,
        weightBps: row.weight_bps,
        holdingCents: row.holding_cents,
        effectiveTargetBps: effectiveTarget,
        actualBps: actual,
        driftBps: totalCents > 0 ? actual - effectiveTarget : 0,
        sortOrder: row.sort_order,
      };
    });

    const holdingCents = assets.reduce((sum, asset) => sum + asset.holdingCents, 0);
    const actual = actualBps(holdingCents, totalCents);

    return {
      id: sleeveRow.id,
      accountId: sleeveRow.account_id,
      label: sleeveRow.label,
      targetBps: sleeveRow.target_bps,
      sortOrder: sleeveRow.sort_order,
      assets,
      holdingCents,
      actualBps: actual,
      driftBps: totalCents > 0 ? actual - sleeveRow.target_bps : 0,
      assetWeightTotalBps: assets.reduce((sum, asset) => sum + asset.weightBps, 0),
    };
  });

  const holdingsByAccount = new Map<string, number>();
  for (const sleeve of sleeves) {
    holdingsByAccount.set(
      sleeve.accountId,
      (holdingsByAccount.get(sleeve.accountId) ?? 0) + sleeve.holdingCents,
    );
  }

  const accounts: Account[] = accountsResult.rows.map((row) => ({
    id: row.id,
    label: row.label,
    note: row.note,
    roomLimitCents: row.room_limit,
    roomUsedCents: row.room_used,
    roomRemainingCents: row.room_limit === null ? null : Math.max(0, row.room_limit - row.room_used),
    holdingCents: holdingsByAccount.get(row.id) ?? 0,
    sortOrder: row.sort_order,
  }));

  return { accounts, sleeves, totalCents };
}
