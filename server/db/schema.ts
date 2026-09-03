import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    note: text('note').notNull().default(''),
    // Total CRA contribution room, in cents. NULL means "no limit" (non-registered).
    roomLimit: bigint('room_limit', { mode: 'number' }),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [
    check('account_label_present', sql`btrim(${t.label}) <> ''`),
    check('room_limit_non_negative', sql`${t.roomLimit} IS NULL OR ${t.roomLimit} >= 0`),
  ],
);

export const sleeves = pgTable(
  'sleeves',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    // Target weight as a fraction of the TOTAL portfolio, in basis points.
    targetBps: integer('target_bps').notNull(),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [
    index('sleeves_account_idx').on(t.accountId),
    check('sleeve_label_present', sql`btrim(${t.label}) <> ''`),
    check('target_bps_valid', sql`${t.targetBps} BETWEEN 0 AND 10000`),
  ],
);

export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    sleeveId: text('sleeve_id')
      .notNull()
      .references(() => sleeves.id, { onDelete: 'cascade' }),
    ticker: text('ticker').notNull(),
    label: text('label').notNull().default(''),
    // Target weight as a fraction of the PARENT SLEEVE, in basis points.
    weightBps: integer('weight_bps').notNull(),
    // Current book value of this asset, in cents. The only stored holding figure.
    holdingCents: bigint('holding_cents', { mode: 'number' }).notNull().default(0),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [
    index('assets_sleeve_idx').on(t.sleeveId),
    unique('asset_ticker_unique_in_sleeve').on(t.sleeveId, t.ticker),
    check('asset_ticker_present', sql`btrim(${t.ticker}) <> ''`),
    check('weight_bps_valid', sql`${t.weightBps} BETWEEN 0 AND 10000`),
    check('holding_non_negative', sql`${t.holdingCents} >= 0`),
  ],
);

export const investments = pgTable(
  'investments',
  {
    id: serial('id').primaryKey(),
    label: text('label').notNull().default(''),
    requestedCents: bigint('requested_cents', { mode: 'number' }).notNull(),
    allocatedCents: bigint('allocated_cents', { mode: 'number' }).notNull(),
    unallocatedCents: bigint('unallocated_cents', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('requested_positive', sql`${t.requestedCents} > 0`),
    check(
      'allocation_balances',
      sql`${t.allocatedCents} + ${t.unallocatedCents} = ${t.requestedCents}`,
    ),
  ],
);

export const investmentLines = pgTable(
  'investment_lines',
  {
    id: serial('id').primaryKey(),
    investmentId: integer('investment_id')
      .notNull()
      .references(() => investments.id, { onDelete: 'cascade' }),
    // No onDelete here: an asset that ever appears in investment history can never
    // be deleted (Postgres NO ACTION / RESTRICT). The app-level delete-blocker check
    // only exists to turn the resulting FK violation into a clean 409.
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id),
    intendedCents: bigint('intended_cents', { mode: 'number' }).notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('investment_lines_investment_idx').on(t.investmentId),
    index('investment_lines_asset_idx').on(t.assetId),
    unique('investment_lines_investment_id_asset_id_key').on(t.investmentId, t.assetId),
    check(
      'amounts_non_negative',
      sql`${t.amountCents} >= 0 AND ${t.intendedCents} >= ${t.amountCents}`,
    ),
  ],
);
