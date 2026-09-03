import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deleteBlockers, readPortfolio } from './portfolio';
import { createTestDatabase, loadExample, type TestDatabase } from './test/db';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('portfolio');
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.reset();
  await loadExample(db.orm);
});

/** Reads portfolio state straight off the Drizzle handle, like the routes do. */
async function read() {
  return readPortfolio(db.orm);
}

/** Records an investment line directly, bypassing the API, to set up ledger state. */
async function recordInvestment(lines: Record<string, number>) {
  const total = Object.values(lines).reduce((a, b) => a + b, 0);
  const { rows } = await db.pool.query<{ id: number }>(
    `INSERT INTO investments (requested_cents, allocated_cents, unallocated_cents)
     VALUES ($1, $1, 0) RETURNING id`,
    [total],
  );
  for (const [assetId, cents] of Object.entries(lines)) {
    await db.pool.query(
      `INSERT INTO investment_lines (investment_id, asset_id, intended_cents, amount_cents)
       VALUES ($1, $2, $3, $3)`,
      [rows[0].id, assetId, cents],
    );
    await db.pool.query('UPDATE assets SET holding_cents = holding_cents + $1 WHERE id = $2', [
      cents,
      assetId,
    ]);
  }
  return rows[0].id;
}

describe('readPortfolio money types', () => {
  it('returns roomUsedCents as a number, not a string', async () => {
    // Regression: SUM() over BIGINT returns NUMERIC, which bypasses the INT8 type
    // parser in db/pool.ts and arrives as a string. It coerced correctly in
    // arithmetic, so it went unnoticed until a manual check of the JSON.
    const empty = await read();
    for (const account of empty.accounts) {
      expect(typeof account.roomUsedCents, `${account.id} with no investments`).toBe('number');
    }

    await recordInvestment({ us_equity_vti: 450_000, cad_equity_vcn: 200_000 });

    const populated = await read();
    for (const account of populated.accounts) {
      expect(typeof account.roomUsedCents, `${account.id} with investments`).toBe('number');
    }
    expect(populated.accounts.find((a) => a.id === 'rrsp')!.roomUsedCents).toBe(450_000);
  });

  it('returns every money and weight field as a number, at both levels', async () => {
    await recordInvestment({ us_equity_vti: 450_000 });
    const portfolio = await read();

    expect(typeof portfolio.totalCents).toBe('number');
    for (const sleeve of portfolio.sleeves) {
      expect(typeof sleeve.holdingCents).toBe('number');
      expect(typeof sleeve.targetBps).toBe('number');
      expect(typeof sleeve.actualBps).toBe('number');
      expect(typeof sleeve.driftBps).toBe('number');
      for (const asset of sleeve.assets) {
        expect(typeof asset.holdingCents).toBe('number');
        expect(typeof asset.weightBps).toBe('number');
        expect(typeof asset.actualBps).toBe('number');
        expect(typeof asset.driftBps).toBe('number');
      }
    }
    for (const account of portfolio.accounts) {
      expect(typeof account.holdingCents).toBe('number');
    }
  });
});

describe('readPortfolio contribution room', () => {
  it('leaves non-registered unlimited', async () => {
    const portfolio = await read();
    const nonRegistered = portfolio.accounts.find((a) => a.id === 'non_registered')!;
    expect(nonRegistered.roomLimitCents).toBeNull();
    expect(nonRegistered.roomRemainingCents).toBeNull();
  });

  it('derives room used from the ledger, so deleting an investment returns it', async () => {
    const investmentId = await recordInvestment({ us_equity_vti: 1_000_000 });
    expect((await read()).accounts.find((a) => a.id === 'rrsp')!.roomUsedCents).toBe(1_000_000);

    await db.pool.query('DELETE FROM investments WHERE id = $1', [investmentId]);
    expect((await read()).accounts.find((a) => a.id === 'rrsp')!.roomUsedCents).toBe(0);
  });

  it('floors remaining room at zero when the limit is lowered below what is used', async () => {
    await recordInvestment({ us_equity_vti: 4_000_000 });
    await db.pool.query("UPDATE accounts SET room_limit = 1_000_00 WHERE id = 'rrsp'");

    const rrsp = (await read()).accounts.find((a) => a.id === 'rrsp')!;
    expect(rrsp.roomUsedCents).toBe(4_000_000);
    expect(rrsp.roomRemainingCents).toBe(0);
  });

  it('sums room across every sleeve in an account', async () => {
    await recordInvestment({ us_equity_vti: 450_000, cad_bonds_vab: 100_000 });
    expect((await read()).accounts.find((a) => a.id === 'rrsp')!.roomUsedCents).toBe(550_000);
  });
});

describe('readPortfolio weights', () => {
  it('reports zero drift for an empty portfolio rather than dividing by zero', async () => {
    const portfolio = await read();
    expect(portfolio.totalCents).toBe(0);
    for (const sleeve of portfolio.sleeves) {
      expect(sleeve.actualBps).toBe(0);
      expect(sleeve.driftBps).toBe(0);
      for (const asset of sleeve.assets) {
        expect(asset.actualBps).toBe(0);
        expect(asset.driftBps).toBe(0);
      }
    }
  });

  it('computes drift against the target once money is present', async () => {
    // On target: 45/10/20/15/10 of $10,000.
    await recordInvestment({
      us_equity_vti: 450_000,
      cad_bonds_vab: 100_000,
      cad_equity_vcn: 200_000,
      intl_equity_xef: 150_000,
      em_equity_vee: 100_000,
    });

    for (const sleeve of (await read()).sleeves) {
      expect(sleeve.actualBps, sleeve.id).toBe(sleeve.targetBps);
      expect(sleeve.driftBps, sleeve.id).toBe(0);
    }
  });

  it('signs drift so underweight is negative and overweight positive', async () => {
    await recordInvestment({ us_equity_vti: 900_000, cad_equity_vcn: 100_000 });
    const sleeves = (await read()).sleeves;

    expect(sleeves.find((s) => s.id === 'us_equity')!.driftBps).toBeGreaterThan(0);
    expect(sleeves.find((s) => s.id === 'cad_equity')!.driftBps).toBeLessThan(0);
  });

  it('orders accounts, sleeves and assets by their sort order', async () => {
    const portfolio = await read();
    expect(portfolio.accounts.map((a) => a.id)).toEqual(['rrsp', 'tfsa', 'non_registered']);
    expect(portfolio.sleeves.map((s) => s.id)).toEqual([
      'us_equity',
      'cad_bonds',
      'cad_equity',
      'intl_equity',
      'em_equity',
    ]);
    expect(portfolio.sleeves.find((s) => s.id === 'us_equity')!.assets.map((a) => a.id)).toEqual([
      'us_equity_vti',
    ]);
  });

  it('rolls asset holdings up into sleeve and account totals', async () => {
    await recordInvestment({ us_equity_vti: 450_000, cad_bonds_vab: 100_000 });
    const portfolio = await read();

    expect(portfolio.sleeves.find((s) => s.id === 'us_equity')!.holdingCents).toBe(450_000);
    expect(portfolio.accounts.find((a) => a.id === 'rrsp')!.holdingCents).toBe(550_000);
  });
});

describe('deleteBlockers', () => {
  it('reports nothing blocking a fresh asset, sleeve or account', async () => {
    expect(await deleteBlockers(db.orm, 'asset', 'us_equity_vti')).toEqual({
      holdingCents: 0,
      hasHistory: false,
    });
    expect(await deleteBlockers(db.orm, 'sleeve', 'us_equity')).toEqual({
      holdingCents: 0,
      hasHistory: false,
    });
    expect(await deleteBlockers(db.orm, 'account', 'rrsp')).toEqual({
      holdingCents: 0,
      hasHistory: false,
    });
  });

  it('reports current holdings as a blocker, scoped to descendants', async () => {
    await recordInvestment({ us_equity_vti: 450_000 });
    expect(await deleteBlockers(db.orm, 'asset', 'us_equity_vti')).toMatchObject({
      holdingCents: 450_000,
      hasHistory: true,
    });
    expect(await deleteBlockers(db.orm, 'sleeve', 'cad_bonds')).toEqual({
      holdingCents: 0,
      hasHistory: false,
    });
  });

  it('keeps hasHistory true after the asset is zeroed out', async () => {
    await recordInvestment({ us_equity_vti: 450_000 });
    await db.pool.query("UPDATE assets SET holding_cents = 0 WHERE id = 'us_equity_vti'");

    expect(await deleteBlockers(db.orm, 'asset', 'us_equity_vti')).toEqual({
      holdingCents: 0,
      hasHistory: true,
    });
  });

  it('scopes account-level blockers to every descendant asset', async () => {
    await recordInvestment({ cad_bonds_vab: 100_000 });
    expect(await deleteBlockers(db.orm, 'account', 'rrsp')).toMatchObject({
      holdingCents: 100_000,
      hasHistory: true,
    });
  });
});
