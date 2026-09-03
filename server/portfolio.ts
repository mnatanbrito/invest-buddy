import { eq, sql } from 'drizzle-orm';
import type { Executor } from './db/pool';
import { accounts, assets, investmentLines, sleeves } from './db/schema';
import { actualBps, effectiveTargetBps } from '../shared/rebalance';
import type { Account, Asset, PortfolioState, Sleeve } from '../shared/types';

export type EntityKind = 'account' | 'sleeve' | 'asset';

export interface DeleteBlock {
  holdingCents: number;
  hasHistory: boolean;
}

/** What would stop `id` (of kind `kind`) from being deleted. */
export async function deleteBlockers(
  exec: Executor,
  kind: EntityKind,
  id: string,
): Promise<DeleteBlock> {
  const scope =
    kind === 'asset'
      ? eq(assets.id, id)
      : kind === 'sleeve'
        ? eq(assets.sleeveId, id)
        : sql`${assets.sleeveId} IN (SELECT ${sleeves.id} FROM ${sleeves} WHERE ${sleeves.accountId} = ${id})`;

  const [holding] = await exec
    .select({ cents: sql<number>`coalesce(sum(${assets.holdingCents}), 0)::bigint` })
    .from(assets)
    .where(scope);

  const history = await exec
    .select({ one: sql`1` })
    .from(investmentLines)
    .innerJoin(assets, eq(assets.id, investmentLines.assetId))
    .where(scope)
    .limit(1);

  return { holdingCents: holding.cents, hasHistory: history.length > 0 };
}

const SORT_TABLES = { accounts, sleeves, assets } as const;
export type SortableTable = keyof typeof SORT_TABLES;

/** Next sort_order for a new row: one past the current max within its parent scope. */
export async function nextSortOrder(
  exec: Executor,
  table: SortableTable,
  parentId: string | null,
): Promise<number> {
  const t = SORT_TABLES[table];
  const where =
    table === 'sleeves' && parentId !== null
      ? eq(sleeves.accountId, parentId)
      : table === 'assets' && parentId !== null
        ? eq(assets.sleeveId, parentId)
        : undefined;
  const [row] = await exec
    .select({ next: sql<number>`coalesce(max(${t.sortOrder}), 0) + 1` })
    .from(t)
    .where(where);
  return row.next;
}

/** Update an entity's sort_order to a new position. */
export async function resequence(
  exec: Executor,
  table: SortableTable,
  id: string,
  sortOrder: number,
): Promise<void> {
  const t = SORT_TABLES[table];
  await exec.update(t).set({ sortOrder }).where(eq(t.id, id));
}

export async function readPortfolio(exec: Executor): Promise<PortfolioState> {
  // Contribution room used is derived from the ledger rather than stored, so
  // undoing an investment gives the room back with no extra bookkeeping.
  const usedByAccount = exec
    .select({
      accountId: sleeves.accountId,
      total: sql<number>`sum(${investmentLines.amountCents})::bigint`.as('total'),
    })
    .from(investmentLines)
    .innerJoin(assets, eq(assets.id, investmentLines.assetId))
    .innerJoin(sleeves, eq(sleeves.id, assets.sleeveId))
    .groupBy(sleeves.accountId)
    .as('used');

  // Sequential, not Promise.all. When `exec` is a transaction the three reads
  // share one connection and one snapshot, so parallelism buys nothing. When
  // `/api/portfolio` and `/api/preview` pass the pool-bound `db` instead, the
  // reads may land on different pooled connections and see independent READ
  // COMMITTED snapshots — not a regression: the pre-Drizzle code called
  // `pool.connect()` without a `BEGIN`, so every statement already ran in its
  // own snapshot the same way.
  const accountRows = await exec
    .select({
      id: accounts.id,
      label: accounts.label,
      note: accounts.note,
      roomLimit: accounts.roomLimit,
      sortOrder: accounts.sortOrder,
      roomUsed: sql<number>`coalesce(${usedByAccount.total}, 0)::bigint`,
    })
    .from(accounts)
    .leftJoin(usedByAccount, eq(usedByAccount.accountId, accounts.id))
    .orderBy(accounts.sortOrder, accounts.id);

  const sleeveRows = await exec
    .select({
      id: sleeves.id,
      accountId: sleeves.accountId,
      label: sleeves.label,
      targetBps: sleeves.targetBps,
      sortOrder: sleeves.sortOrder,
    })
    .from(sleeves)
    .innerJoin(accounts, eq(accounts.id, sleeves.accountId))
    .orderBy(accounts.sortOrder, accounts.id, sleeves.sortOrder, sleeves.id);

  const assetRows = await exec
    .select({
      id: assets.id,
      sleeveId: assets.sleeveId,
      ticker: assets.ticker,
      label: assets.label,
      weightBps: assets.weightBps,
      holdingCents: assets.holdingCents,
      sortOrder: assets.sortOrder,
    })
    .from(assets)
    .innerJoin(sleeves, eq(sleeves.id, assets.sleeveId))
    .innerJoin(accounts, eq(accounts.id, sleeves.accountId))
    .orderBy(
      accounts.sortOrder,
      accounts.id,
      sleeves.sortOrder,
      sleeves.id,
      assets.sortOrder,
      assets.id,
    );

  type AssetRow = (typeof assetRows)[number];
  const totalCents = assetRows.reduce((sum, row) => sum + row.holdingCents, 0);

  const assetsBySleeve = new Map<string, AssetRow[]>();
  for (const row of assetRows) {
    const list = assetsBySleeve.get(row.sleeveId) ?? [];
    list.push(row);
    assetsBySleeve.set(row.sleeveId, list);
  }

  const sleevesOut: Sleeve[] = sleeveRows.map((sleeveRow) => {
    const rows = assetsBySleeve.get(sleeveRow.id) ?? [];
    const assetsOut: Asset[] = rows.map((row) => {
      const actual = actualBps(row.holdingCents, totalCents);
      const effectiveTarget = effectiveTargetBps(sleeveRow.targetBps, row.weightBps);
      return {
        id: row.id,
        sleeveId: row.sleeveId,
        ticker: row.ticker,
        label: row.label,
        weightBps: row.weightBps,
        holdingCents: row.holdingCents,
        effectiveTargetBps: effectiveTarget,
        actualBps: actual,
        driftBps: totalCents > 0 ? actual - effectiveTarget : 0,
        sortOrder: row.sortOrder,
      };
    });

    const holdingCents = assetsOut.reduce((sum, a) => sum + a.holdingCents, 0);
    const actual = actualBps(holdingCents, totalCents);

    return {
      id: sleeveRow.id,
      accountId: sleeveRow.accountId,
      label: sleeveRow.label,
      targetBps: sleeveRow.targetBps,
      sortOrder: sleeveRow.sortOrder,
      assets: assetsOut,
      holdingCents,
      actualBps: actual,
      driftBps: totalCents > 0 ? actual - sleeveRow.targetBps : 0,
      assetWeightTotalBps: assetsOut.reduce((sum, a) => sum + a.weightBps, 0),
    };
  });

  const holdingsByAccount = new Map<string, number>();
  for (const sleeve of sleevesOut) {
    holdingsByAccount.set(
      sleeve.accountId,
      (holdingsByAccount.get(sleeve.accountId) ?? 0) + sleeve.holdingCents,
    );
  }

  const accountsOut: Account[] = accountRows.map((row) => ({
    id: row.id,
    label: row.label,
    note: row.note,
    roomLimitCents: row.roomLimit,
    roomUsedCents: row.roomUsed,
    roomRemainingCents:
      row.roomLimit === null ? null : Math.max(0, row.roomLimit - row.roomUsed),
    holdingCents: holdingsByAccount.get(row.id) ?? 0,
    sortOrder: row.sortOrder,
  }));

  return { accounts: accountsOut, sleeves: sleevesOut, totalCents };
}
