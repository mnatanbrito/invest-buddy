import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../test/db';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('schema');
});

afterAll(async () => {
  await db.drop();
});

describe('schema built from the generated migrations', () => {
  it('creates the five tables', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'accounts',
      'assets',
      'investment_lines',
      'investments',
      'sleeves',
    ]);
  });

  it('carries every named CHECK constraint', async () => {
    const { rows } = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE contype = 'c' ORDER BY conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual(
      expect.arrayContaining([
        'account_label_present',
        'allocation_balances',
        'amounts_non_negative',
        'asset_ticker_present',
        'holding_non_negative',
        'requested_positive',
        'room_limit_non_negative',
        'sleeve_label_present',
        'target_bps_valid',
        'weight_bps_valid',
      ]),
    );
  });

  it('keeps investment_lines.asset_id non-cascading while the rest cascade', async () => {
    const { rows } = await db.pool.query<{
      conname: string;
      confdeltype: string;
      table_name: string;
    }>(
      `SELECT c.conname, c.confdeltype, r.relname AS table_name
         FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
        WHERE c.contype = 'f'`,
    );
    const assetFk = rows.find(
      (r) => r.table_name === 'investment_lines' && r.conname.includes('asset_id'),
    );
    // 'a' = NO ACTION, 'c' = CASCADE
    expect(assetFk?.confdeltype).toBe('a');
    for (const r of rows.filter((r) => r !== assetFk)) {
      expect(r.confdeltype, r.conname).toBe('c');
    }
  });

  it('carries the composite uniques and the explicit indexes', async () => {
    const { rows } = await db.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'sleeves_account_idx',
        'assets_sleeve_idx',
        'investment_lines_investment_idx',
        'investment_lines_asset_idx',
        'investment_lines_investment_id_asset_id_key',
        'asset_ticker_unique_in_sleeve',
      ]),
    );
  });
});
