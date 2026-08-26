import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createTestDatabase, loadExample, type TestDatabase } from './test/db';
import type { AllocationPlan, InvestmentRecord, PortfolioState } from '../shared/types';

let db: TestDatabase;
let app: Express;

beforeAll(async () => {
  db = await createTestDatabase('api');
  app = createApp(db.pool);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.reset();
  await loadExample(db.pool);
});

const invest = (amountCents: unknown) =>
  request(app).post('/api/invest').send({ amountCents }).set('content-type', 'application/json');

const assetAmounts = (plan: AllocationPlan) =>
  Object.fromEntries(plan.lines.map((line) => [line.assetId, line.amountCents]));

describe('POST /api/invest validation', () => {
  it('rejects zero and negative amounts', async () => {
    await expect(invest(0).expect(400)).resolves.toMatchObject({
      body: { error: 'enter an amount greater than zero' },
    });
    await expect(invest(-100).expect(400)).resolves.toMatchObject({
      body: { error: 'enter an amount greater than zero' },
    });
  });

  it('rejects fractional cents rather than rounding them', async () => {
    const response = await invest(10.5).expect(400);
    expect(response.body.error).toBe('amount must be a whole number of cents');
  });

  it('rejects a missing or non-numeric amount', async () => {
    await request(app).post('/api/invest').send({}).expect(400);
    await invest('5000').expect(400);
    await invest(null).expect(400);
  });

  it('leaves the portfolio untouched when validation fails', async () => {
    await invest(0).expect(400);
    const { body } = await request(app).get('/api/portfolio').expect(200);
    expect((body as PortfolioState).totalCents).toBe(0);
  });
});

describe('POST /api/invest', () => {
  it('splits an opening deposit onto the target weights and persists it', async () => {
    const { body } = await invest(1_000_000).expect(200);

    expect(assetAmounts(body.plan)).toEqual({
      us_equity_vti: 450_000,
      cad_bonds_vab: 100_000,
      cad_equity_vcn: 200_000,
      intl_equity_xef: 150_000,
      em_equity_vee: 100_000,
    });
    expect(body.portfolio.totalCents).toBe(1_000_000);

    const rows = await db.pool.query('SELECT COUNT(*)::int AS n FROM investment_lines');
    expect(rows.rows[0].n).toBe(5);
  });

  it('keeps asset holdings equal to what it reported allocating', async () => {
    await invest(1_000_000).expect(200);
    await invest(333_333).expect(200);

    const { body } = await request(app).get('/api/portfolio').expect(200);
    const portfolio = body as PortfolioState;
    const summed = portfolio.sleeves
      .flatMap((sleeve) => sleeve.assets)
      .reduce((total, asset) => total + asset.holdingCents, 0);
    expect(summed).toBe(portfolio.totalCents);
    expect(summed).toBe(1_000_000 + 333_333);
  });

  it('routes a later deposit to the underweight assets', async () => {
    await request(app)
      .put('/api/holdings')
      .send({
        holdings: {
          us_equity_vti: 900_000,
          cad_bonds_vab: 0,
          cad_equity_vcn: 0,
          intl_equity_xef: 0,
          em_equity_vee: 0,
        },
      })
      .expect(200);

    const { body } = await invest(1_000_000).expect(200);
    const amounts = assetAmounts(body.plan);

    // US equity is far overweight, so it should be starved in favour of the rest.
    expect(amounts.us_equity_vti).toBe(0);
    expect(amounts.cad_equity_vcn).toBeGreaterThan(0);
    expect(body.plan.allocatedCents).toBe(1_000_000);
  });

  it('refuses to invest when the allocation is incomplete', async () => {
    await db.pool.query("UPDATE sleeves SET target_bps = 4000 WHERE id = 'us_equity'");
    const { body } = await invest(1_000_000).expect(400);
    expect(body.error).toMatch(/not 100%/);
  });
});

describe('contribution room capping', () => {
  it('writes only what fits and reports the rest as unallocated cash', async () => {
    const { body } = await invest(10_000_000).expect(200);
    const plan = body.plan as AllocationPlan;

    expect(plan.cappedAccountIds.sort()).toEqual(['rrsp', 'tfsa']);
    expect(plan.allocatedCents + plan.unallocatedCents).toBe(10_000_000);
    expect(plan.unallocatedCents).toBeGreaterThan(0);

    // Seeded room is $50,000 RRSP and $25,000 TFSA.
    const accounts = (body.portfolio as PortfolioState).accounts;
    expect(accounts.find((a) => a.id === 'rrsp')!.roomUsedCents).toBe(5_000_000);
    expect(accounts.find((a) => a.id === 'tfsa')!.roomUsedCents).toBe(2_500_000);
    expect(accounts.find((a) => a.id === 'rrsp')!.roomRemainingCents).toBe(0);
  });

  it('never lets recorded contributions exceed the room limit', async () => {
    await invest(10_000_000).expect(200);
    await invest(10_000_000).expect(200);

    const { body } = await request(app).get('/api/portfolio').expect(200);
    for (const account of (body as PortfolioState).accounts) {
      if (account.roomLimitCents === null) continue;
      expect(account.roomUsedCents).toBeLessThanOrEqual(account.roomLimitCents);
    }
  });

  it('sends nothing to a registered account once its room is gone', async () => {
    await invest(10_000_000).expect(200);
    const { body } = await invest(500_000).expect(200);
    const amounts = assetAmounts(body.plan as AllocationPlan);

    expect(amounts.us_equity_vti).toBe(0);
    expect(amounts.cad_bonds_vab).toBe(0);
    expect(amounts.cad_equity_vcn).toBe(0);
    expect(amounts.intl_equity_xef).toBe(0);
  });

  it('holds the whole deposit as cash when room is gone and non-registered is overweight', async () => {
    // Capping the registered accounts leaves emerging markets above its target,
    // so drift-aware allocation correctly sends it nothing either and the entire
    // deposit comes back as cash rather than being forced somewhere.
    await invest(10_000_000).expect(200);
    const { body } = await invest(500_000).expect(200);
    const plan = body.plan as AllocationPlan;

    expect(plan.allocatedCents).toBe(0);
    expect(plan.unallocatedCents).toBe(500_000);
  });

  it('still funds non-registered when it is underweight and registered room is gone', async () => {
    await invest(10_000_000).expect(200);
    // Drop emerging markets below its target while the registered rooms stay full.
    await request(app)
      .put('/api/holdings')
      .send({ holdings: { em_equity_vee: 0 } })
      .expect(200);

    const { body } = await invest(500_000).expect(200);
    const plan = body.plan as AllocationPlan;
    const amounts = assetAmounts(plan);

    // Emerging markets is the only asset that can actually be funded. The TFSA
    // sleeves are underweight too, so they still claim a share of the deposit and
    // then have it blocked, which is why the rest comes back as cash.
    expect(amounts.em_equity_vee).toBeGreaterThan(0);
    expect(plan.allocatedCents).toBe(amounts.em_equity_vee);
    for (const line of plan.lines) {
      if (line.accountId !== 'non_registered') expect(line.amountCents).toBe(0);
    }
    expect(plan.allocatedCents + plan.unallocatedCents).toBe(500_000);
  });
});

describe('POST /api/undo', () => {
  it('returns both the money and the contribution room', async () => {
    await invest(1_000_000).expect(200);
    const { body } = await request(app).post('/api/undo').expect(200);
    const portfolio = body as PortfolioState;

    expect(portfolio.totalCents).toBe(0);
    for (const account of portfolio.accounts) {
      expect(account.roomUsedCents).toBe(0);
    }
    expect((await db.pool.query('SELECT COUNT(*)::int AS n FROM investments')).rows[0].n).toBe(0);
  });

  it('cascades the lines away with the investment', async () => {
    await invest(1_000_000).expect(200);
    await request(app).post('/api/undo').expect(200);
    const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM investment_lines');
    expect(rows[0].n).toBe(0);
  });

  it('unwinds one investment at a time, newest first', async () => {
    await invest(1_000_000).expect(200);
    await invest(2_000_000).expect(200);

    const { body } = await request(app).post('/api/undo').expect(200);
    expect((body as PortfolioState).totalCents).toBe(1_000_000);

    const { body: second } = await request(app).post('/api/undo').expect(200);
    expect((second as PortfolioState).totalCents).toBe(0);
  });

  it('reports a conflict when there is nothing to undo', async () => {
    const { body } = await request(app).post('/api/undo').expect(409);
    expect(body.error).toBe('there is nothing to undo');
  });
});

describe('PUT /api/holdings', () => {
  it('sets opening balances', async () => {
    const { body } = await request(app)
      .put('/api/holdings')
      .send({ holdings: { us_equity_vti: 123_456, cad_bonds_vab: 1_000 } })
      .expect(200);

    const assets = (body as PortfolioState).sleeves.flatMap((s) => s.assets);
    expect(assets.find((a) => a.id === 'us_equity_vti')!.holdingCents).toBe(123_456);
    expect(assets.find((a) => a.id === 'cad_bonds_vab')!.holdingCents).toBe(1_000);
  });

  it('rolls the whole request back when one asset id is unknown', async () => {
    // us_equity_vti is valid and comes first; it must not survive the failed request.
    await request(app)
      .put('/api/holdings')
      .send({ holdings: { us_equity_vti: 999_999, not_an_asset: 1_000 } })
      .expect(404);

    const { body } = await request(app).get('/api/portfolio').expect(200);
    const usEquity = (body as PortfolioState).sleeves
      .flatMap((s) => s.assets)
      .find((a) => a.id === 'us_equity_vti')!;
    expect(usEquity.holdingCents).toBe(0);
  });

  it('rejects negative and fractional holdings', async () => {
    await request(app).put('/api/holdings').send({ holdings: { us_equity_vti: -1 } }).expect(400);
    await request(app).put('/api/holdings').send({ holdings: { us_equity_vti: 1.5 } }).expect(400);
  });
});

describe('GET /api/history', () => {
  it('returns investments newest first, with their lines', async () => {
    await invest(1_000_000).expect(200);
    await invest(2_000_000).expect(200);

    const { body } = await request(app).get('/api/history').expect(200);
    const history = body as InvestmentRecord[];

    expect(history).toHaveLength(2);
    expect(history[0].requestedCents).toBe(2_000_000);
    expect(history[1].requestedCents).toBe(1_000_000);
    expect(history[0].lines).toHaveLength(5);
    expect(history[0].lines[0]).toMatchObject({
      assetId: expect.any(String),
      sleeveId: expect.any(String),
      amountCents: expect.any(Number),
      intendedCents: expect.any(Number),
    });
  });

  it('returns an empty array when nothing has been recorded', async () => {
    const { body } = await request(app).get('/api/history').expect(200);
    expect(body).toEqual([]);
  });
});

describe('POST /api/accounts', () => {
  it('creates an account and it appears in the portfolio', async () => {
    const { body } = await request(app)
      .post('/api/accounts')
      .send({ label: 'RESP', note: 'For the kid', roomLimitCents: 1_000_000 })
      .expect(201);

    const portfolio = body as PortfolioState;
    const created = portfolio.accounts.find((a) => a.label === 'RESP')!;
    expect(created).toBeDefined();
    expect(created.note).toBe('For the kid');
    expect(created.roomLimitCents).toBe(1_000_000);
    // Example preset already seeds sort orders 1-3, so the new account lands at 4.
    expect(created.sortOrder).toBe(4);
  });

  it('rejects an empty label', async () => {
    const { body } = await request(app).post('/api/accounts').send({ label: '  ' }).expect(400);
    expect(body.error).toBeTruthy();
  });

  it('enforces the maximum of 10 accounts', async () => {
    // The example preset already loads 3; 7 more reaches the cap of 10.
    for (let i = 0; i < 7; i++) {
      await request(app)
        .post('/api/accounts')
        .send({ label: `Extra ${i}` })
        .expect(201);
    }

    const { body } = await request(app).post('/api/accounts').send({ label: 'One too many' }).expect(409);
    expect(body.error).toMatch(/10/);

    const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM accounts');
    expect(rows[0].n).toBe(10);
  });
});

describe('PATCH /api/accounts/:id', () => {
  it('updates label without clobbering an existing note', async () => {
    const before = await request(app).get('/api/portfolio').expect(200);
    const rrspBefore = (before.body as PortfolioState).accounts.find((a) => a.id === 'rrsp')!;
    expect(rrspBefore.note).not.toBe('');

    const { body } = await request(app).patch('/api/accounts/rrsp').send({ label: 'New label' }).expect(200);
    const rrsp = (body as PortfolioState).accounts.find((a) => a.id === 'rrsp')!;
    expect(rrsp.label).toBe('New label');
    expect(rrsp.note).toBe(rrspBefore.note);
  });

  it('updates note without clobbering the label', async () => {
    const { body } = await request(app)
      .patch('/api/accounts/rrsp')
      .send({ note: 'Updated note' })
      .expect(200);
    const rrsp = (body as PortfolioState).accounts.find((a) => a.id === 'rrsp')!;
    expect(rrsp.note).toBe('Updated note');
    expect(rrsp.label).toBe('RRSP');
  });

  it('updates roomLimitCents independently', async () => {
    const { body } = await request(app)
      .patch('/api/accounts/rrsp')
      .send({ roomLimitCents: 7_500_000 })
      .expect(200);
    const rrsp = (body as PortfolioState).accounts.find((a) => a.id === 'rrsp')!;
    expect(rrsp.roomLimitCents).toBe(7_500_000);
    expect(rrsp.label).toBe('RRSP');
  });

  it('clears an existing room limit with roomLimitCents: null', async () => {
    const { body } = await request(app)
      .patch('/api/accounts/rrsp')
      .send({ roomLimitCents: null })
      .expect(200);
    const rrsp = (body as PortfolioState).accounts.find((a) => a.id === 'rrsp')!;
    expect(rrsp.roomLimitCents).toBeNull();
  });

  it('moves an account via sortOrder', async () => {
    // rrsp starts at sortOrder 1; move it after tfsa (sortOrder 2).
    await request(app).patch('/api/accounts/rrsp').send({ sortOrder: 3 }).expect(200);
    const { body } = await request(app).get('/api/portfolio').expect(200);
    const rrsp = (body as PortfolioState).accounts.find((a) => a.id === 'rrsp')!;
    expect(rrsp.sortOrder).toBe(3);
  });

  it('reorders the account list with the two-PATCH swap the UI issues', async () => {
    // Mirrors moveSortOrder (src/lib/editor.ts): swap rrsp (sortOrder 1) and tfsa
    // (sortOrder 2) by PATCHing the moving item first, then its sibling — using the
    // second (sibling's) response as authoritative, same as AccountCard.tsx does.
    const before = await request(app).get('/api/portfolio').expect(200);
    const accountsBefore = (before.body as PortfolioState).accounts;
    const rrspBefore = accountsBefore.find((a) => a.id === 'rrsp')!;
    const tfsaBefore = accountsBefore.find((a) => a.id === 'tfsa')!;

    await request(app)
      .patch(`/api/accounts/${rrspBefore.id}`)
      .send({ sortOrder: tfsaBefore.sortOrder })
      .expect(200);
    const { body } = await request(app)
      .patch(`/api/accounts/${tfsaBefore.id}`)
      .send({ sortOrder: rrspBefore.sortOrder })
      .expect(200);

    expect((body as PortfolioState).accounts.map((a) => a.id)).toEqual([
      'tfsa',
      'rrsp',
      'non_registered',
    ]);
  });

  it('404s on an unknown id', async () => {
    const { body } = await request(app).patch('/api/accounts/nope').send({ label: 'X' }).expect(404);
    expect(body.error).toBe('no account with that id');
  });

  it('rejects an empty patch body', async () => {
    await request(app).patch('/api/accounts/rrsp').send({}).expect(400);
  });
});

describe('DELETE /api/accounts/:id', () => {
  it('deletes a fresh, never-invested account', async () => {
    const { body: created } = await request(app)
      .post('/api/accounts')
      .send({ label: 'Throwaway' })
      .expect(201);
    const newId = (created as PortfolioState).accounts.find((a) => a.label === 'Throwaway')!.id;

    await request(app).delete(`/api/accounts/${newId}`).expect(200);

    const { body } = await request(app).get('/api/portfolio').expect(200);
    expect((body as PortfolioState).accounts.find((a) => a.id === newId)).toBeUndefined();
  });

  it('refuses to delete an account with nonzero holdings, mentioning the label and amount', async () => {
    await invest(1_000_000).expect(200);

    const { body } = await request(app).delete('/api/accounts/rrsp').expect(409);
    expect(body.error).toMatch(/RRSP/);
    expect(body.error).toMatch(/\$/);
  });

  it('refuses to delete an account with investment history even once holdings are zeroed', async () => {
    await invest(1_000_000).expect(200);
    await request(app)
      .put('/api/holdings')
      .send({ holdings: { us_equity_vti: 0, cad_bonds_vab: 0 } })
      .expect(200);

    const { body } = await request(app).delete('/api/accounts/rrsp').expect(409);
    expect(body.error).toMatch(/history/);
  });

  it('404s on an unknown id', async () => {
    const { body } = await request(app).delete('/api/accounts/nope').expect(404);
    expect(body.error).toBe('no account with that id');
  });

  it('cascades away sleeves and assets', async () => {
    const { rows: before } = await db.pool.query('SELECT COUNT(*)::int AS n FROM sleeves WHERE account_id = $1', [
      'rrsp',
    ]);
    expect(before[0].n).toBeGreaterThan(0);

    await request(app).delete('/api/accounts/rrsp').expect(200);

    const { rows: sleeveRows } = await db.pool.query(
      'SELECT COUNT(*)::int AS n FROM sleeves WHERE account_id = $1',
      ['rrsp'],
    );
    expect(sleeveRows[0].n).toBe(0);
    const { rows: assetRows } = await db.pool.query(
      `SELECT COUNT(*)::int AS n FROM assets ast
        JOIN sleeves s ON s.id = ast.sleeve_id
       WHERE s.account_id = $1`,
      ['rrsp'],
    );
    expect(assetRows[0].n).toBe(0);
  });
});

describe('POST /api/sleeves', () => {
  it('creates a sleeve under an existing account and it appears in the portfolio', async () => {
    const { body } = await request(app)
      .post('/api/sleeves')
      .send({ accountId: 'tfsa', label: 'Global bonds', targetBps: 500 })
      .expect(201);

    const portfolio = body as PortfolioState;
    const created = portfolio.sleeves.find((s) => s.label === 'Global bonds')!;
    expect(created).toBeDefined();
    expect(created.accountId).toBe('tfsa');
    expect(created.targetBps).toBe(500);
    // tfsa already has sleeves at sortOrder 1-2, so the new one lands at 3.
    expect(created.sortOrder).toBe(3);
  });

  it('404s on an unknown accountId', async () => {
    const { body } = await request(app)
      .post('/api/sleeves')
      .send({ accountId: 'nope', label: 'Ghost', targetBps: 100 })
      .expect(404);
    expect(body.error).toBe('no account with that id');
  });

  it('rejects an out-of-range targetBps', async () => {
    await request(app)
      .post('/api/sleeves')
      .send({ accountId: 'rrsp', label: 'Bad', targetBps: -1 })
      .expect(400);
    await request(app)
      .post('/api/sleeves')
      .send({ accountId: 'rrsp', label: 'Bad', targetBps: 10_001 })
      .expect(400);
  });

  it('enforces the portfolio-wide maximum of 10 sleeves, regardless of which account', async () => {
    // The example preset already has 5 sleeves across 3 accounts (2 in rrsp, 2 in
    // tfsa, 1 in non_registered). Spread 5 more across those same accounts so no
    // single account gets anywhere near 10 — the test only passes if the cap check
    // counts across the whole `sleeves` table, not one scoped to an account_id.
    const accountIds = ['rrsp', 'tfsa', 'non_registered', 'rrsp', 'tfsa'];
    for (const [i, accountId] of accountIds.entries()) {
      await request(app)
        .post('/api/sleeves')
        .send({ accountId, label: `Extra ${i}`, targetBps: 100 })
        .expect(201);
    }

    const { body } = await request(app)
      .post('/api/sleeves')
      .send({ accountId: 'rrsp', label: 'One too many', targetBps: 100 })
      .expect(409);
    expect(body.error).toMatch(/10/);

    const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM sleeves');
    expect(rows[0].n).toBe(10);
  });
});

describe('PATCH /api/sleeves/:id', () => {
  it('updates label without clobbering targetBps', async () => {
    const { body } = await request(app)
      .patch('/api/sleeves/us_equity')
      .send({ label: 'US market cap' })
      .expect(200);
    const sleeve = (body as PortfolioState).sleeves.find((s) => s.id === 'us_equity')!;
    expect(sleeve.label).toBe('US market cap');
    expect(sleeve.targetBps).toBe(4500);
  });

  it('updates targetBps without clobbering the label', async () => {
    const { body } = await request(app)
      .patch('/api/sleeves/us_equity')
      .send({ targetBps: 4000 })
      .expect(200);
    const sleeve = (body as PortfolioState).sleeves.find((s) => s.id === 'us_equity')!;
    expect(sleeve.targetBps).toBe(4000);
    expect(sleeve.label).toBe('US total market');
  });

  it('moves a sleeve via sortOrder', async () => {
    // us_equity starts at sortOrder 1 within rrsp; move it to sortOrder 2.
    await request(app).patch('/api/sleeves/us_equity').send({ sortOrder: 2 }).expect(200);
    const { body } = await request(app).get('/api/portfolio').expect(200);
    const sleeve = (body as PortfolioState).sleeves.find((s) => s.id === 'us_equity')!;
    expect(sleeve.sortOrder).toBe(2);
  });

  it('reorders sleeves within an account with the two-PATCH swap the UI issues', async () => {
    // Mirrors moveSortOrder (src/lib/editor.ts): swap us_equity (sortOrder 1) and
    // cad_bonds (sortOrder 2), both under rrsp, by PATCHing the moving item first,
    // then its sibling — using the second (sibling's) response as authoritative,
    // same as SleeveRow.tsx does.
    const before = await request(app).get('/api/portfolio').expect(200);
    const sleevesBefore = (before.body as PortfolioState).sleeves;
    const usEquityBefore = sleevesBefore.find((s) => s.id === 'us_equity')!;
    const cadBondsBefore = sleevesBefore.find((s) => s.id === 'cad_bonds')!;

    await request(app)
      .patch(`/api/sleeves/${usEquityBefore.id}`)
      .send({ sortOrder: cadBondsBefore.sortOrder })
      .expect(200);
    const { body } = await request(app)
      .patch(`/api/sleeves/${cadBondsBefore.id}`)
      .send({ sortOrder: usEquityBefore.sortOrder })
      .expect(200);

    const rrspSleeveIds = (body as PortfolioState).sleeves
      .filter((s) => s.accountId === 'rrsp')
      .map((s) => s.id);
    expect(rrspSleeveIds).toEqual(['cad_bonds', 'us_equity']);
  });

  it('404s on an unknown id', async () => {
    const { body } = await request(app).patch('/api/sleeves/nope').send({ label: 'X' }).expect(404);
    expect(body.error).toBe('no sleeve with that id');
  });

  it('rejects an empty patch body', async () => {
    await request(app).patch('/api/sleeves/us_equity').send({}).expect(400);
  });
});

describe('DELETE /api/sleeves/:id', () => {
  it('deletes a fresh sleeve with no holdings/history and cascades away its assets', async () => {
    const { body: created } = await request(app)
      .post('/api/sleeves')
      .send({ accountId: 'non_registered', label: 'Throwaway sleeve', targetBps: 0 })
      .expect(201);
    const newId = (created as PortfolioState).sleeves.find((s) => s.label === 'Throwaway sleeve')!.id;

    await db.pool.query(
      `INSERT INTO assets (id, sleeve_id, ticker, label, weight_bps, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [`${newId}_asset`, newId, 'XYZ', '', 10_000, 1],
    );

    await request(app).delete(`/api/sleeves/${newId}`).expect(200);

    const { body } = await request(app).get('/api/portfolio').expect(200);
    expect((body as PortfolioState).sleeves.find((s) => s.id === newId)).toBeUndefined();

    const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM assets WHERE sleeve_id = $1', [
      newId,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it('refuses to delete a sleeve with nonzero holdings, mentioning the label and amount', async () => {
    await invest(1_000_000).expect(200);

    const { body } = await request(app).delete('/api/sleeves/us_equity').expect(409);
    expect(body.error).toMatch(/US total market/);
    expect(body.error).toMatch(/\$/);
  });

  it('refuses to delete a sleeve with investment history even once holdings are zeroed', async () => {
    await invest(1_000_000).expect(200);
    await request(app)
      .put('/api/holdings')
      .send({ holdings: { us_equity_vti: 0 } })
      .expect(200);

    const { body } = await request(app).delete('/api/sleeves/us_equity').expect(409);
    expect(body.error).toMatch(/history/);
  });

  it('404s on an unknown id', async () => {
    const { body } = await request(app).delete('/api/sleeves/nope').expect(404);
    expect(body.error).toBe('no sleeve with that id');
  });
});

describe('POST /api/assets', () => {
  it('creates an asset under an existing sleeve and it appears in the portfolio', async () => {
    const { body } = await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'cad_bonds', ticker: 'zag', label: 'Extra bonds', weightBps: 3000 })
      .expect(201);

    const portfolio = body as PortfolioState;
    const sleeve = portfolio.sleeves.find((s) => s.id === 'cad_bonds')!;
    const created = sleeve.assets.find((a) => a.ticker === 'ZAG')!;
    expect(created).toBeDefined();
    expect(created.sleeveId).toBe('cad_bonds');
    expect(created.ticker).toBe('ZAG');
    expect(created.label).toBe('Extra bonds');
    expect(created.weightBps).toBe(3000);
    expect(created.holdingCents).toBe(0);
  });

  it('404s on an unknown sleeveId', async () => {
    const { body } = await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'nope', ticker: 'ZZZ', weightBps: 100 })
      .expect(404);
    expect(body.error).toBe('no sleeve with that id');
  });

  it('rejects an out-of-range weightBps', async () => {
    await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'cad_bonds', ticker: 'ZAG', weightBps: -1 })
      .expect(400);
    await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'cad_bonds', ticker: 'ZAG', weightBps: 10_001 })
      .expect(400);
  });

  it('409s on a duplicate ticker within the same sleeve, but the same ticker succeeds in a different sleeve', async () => {
    // us_equity already holds VTI.
    const dup = await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'us_equity', ticker: 'VTI', weightBps: 100 })
      .expect(409);
    expect(dup.body.error).toMatch(/VTI/);

    // Uniqueness is per-sleeve, not global: the same ticker in a different sleeve is fine.
    const { body } = await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'cad_bonds', ticker: 'VTI', weightBps: 100 })
      .expect(201);
    const sleeve = (body as PortfolioState).sleeves.find((s) => s.id === 'cad_bonds')!;
    expect(sleeve.assets.find((a) => a.ticker === 'VTI')).toBeDefined();
  });

  it('enforces the per-sleeve maximum of 10 assets without blocking other sleeves', async () => {
    // us_equity already has 1 asset (VTI); 9 more reaches the cap of 10.
    for (let i = 0; i < 9; i++) {
      await request(app)
        .post('/api/assets')
        .send({ sleeveId: 'us_equity', ticker: `X${i}`, weightBps: 100 })
        .expect(201);
    }

    const { body } = await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'us_equity', ticker: 'ONETOOMANY', weightBps: 100 })
      .expect(409);
    expect(body.error).toMatch(/10/);

    const { rows } = await db.pool.query('SELECT COUNT(*)::int AS n FROM assets WHERE sleeve_id = $1', [
      'us_equity',
    ]);
    expect(rows[0].n).toBe(10);

    // A different sleeve, nowhere near the cap, must still accept a new asset —
    // proving the cap is scoped to the sleeve, not the whole portfolio.
    await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'cad_bonds', ticker: 'STILLOK', weightBps: 100 })
      .expect(201);
  });
});

describe('PATCH /api/assets/:id', () => {
  it('updates ticker, label, and weightBps independently without clobbering each other', async () => {
    const { body: afterTicker } = await request(app)
      .patch('/api/assets/us_equity_vti')
      .send({ ticker: 'vun' })
      .expect(200);
    let asset = (afterTicker as PortfolioState).sleeves
      .flatMap((s) => s.assets)
      .find((a) => a.id === 'us_equity_vti')!;
    expect(asset.ticker).toBe('VUN');
    expect(asset.weightBps).toBe(10_000);

    const { body: afterLabel } = await request(app)
      .patch('/api/assets/us_equity_vti')
      .send({ label: 'US total market fund' })
      .expect(200);
    asset = (afterLabel as PortfolioState).sleeves.flatMap((s) => s.assets).find((a) => a.id === 'us_equity_vti')!;
    expect(asset.label).toBe('US total market fund');
    expect(asset.ticker).toBe('VUN');

    const { body: afterWeight } = await request(app)
      .patch('/api/assets/us_equity_vti')
      .send({ weightBps: 5000 })
      .expect(200);
    asset = (afterWeight as PortfolioState).sleeves.flatMap((s) => s.assets).find((a) => a.id === 'us_equity_vti')!;
    expect(asset.weightBps).toBe(5000);
    expect(asset.label).toBe('US total market fund');
    expect(asset.ticker).toBe('VUN');
  });

  it('409s when changing ticker to collide with a sibling asset in the same sleeve', async () => {
    await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'us_equity', ticker: 'ITOT', weightBps: 100 })
      .expect(201);

    const { body } = await request(app).patch('/api/assets/us_equity_vti').send({ ticker: 'itot' }).expect(409);
    expect(body.error).toMatch(/ITOT/);
  });

  it('moves an asset via sortOrder, resolving a resulting sort_order tie by id', async () => {
    // EXTRA is created after us_equity_vti, so it lands at sort_order 2 (next past
    // the sleeve's current max). PATCHing us_equity_vti to sortOrder 2 then leaves
    // both assets at sort_order 2 — readPortfolio's ASSETS_QUERY breaks that tie by
    // `ast.id`, and EXTRA's randomUUID id is always lexicographically less than the
    // literal string "us_equity_vti" (UUID chars are only 0-9/a-f/'-', all < 'u'),
    // so EXTRA deterministically sorts first once the tie happens.
    const { body: created } = await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'us_equity', ticker: 'EXTRA', weightBps: 100 })
      .expect(201);
    const extraId = (created as PortfolioState).sleeves
      .flatMap((s) => s.assets)
      .find((a) => a.ticker === 'EXTRA')!.id;

    await request(app).patch('/api/assets/us_equity_vti').send({ sortOrder: 2 }).expect(200);
    const { body } = await request(app).get('/api/portfolio').expect(200);
    const usEquityAssets = (body as PortfolioState).sleeves.find((s) => s.id === 'us_equity')!.assets;

    expect(usEquityAssets.map((a) => a.id)).toEqual([extraId, 'us_equity_vti']);
    expect(usEquityAssets.map((a) => a.sortOrder)).toEqual([2, 2]);
  });

  it('reorders assets within a sleeve with the two-PATCH swap the UI issues', async () => {
    // Mirrors moveSortOrder (src/lib/editor.ts): swap two siblings within us_equity
    // by PATCHing the moving item first, then its sibling — using the second
    // (sibling's) response as authoritative, same as AssetRow.tsx does. Unlike the
    // test above, this leaves no sort_order tie: the swap is clean.
    const { body: created } = await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'us_equity', ticker: 'SECOND', weightBps: 100 })
      .expect(201);
    const secondId = (created as PortfolioState).sleeves
      .flatMap((s) => s.assets)
      .find((a) => a.ticker === 'SECOND')!.id;

    // us_equity_vti is sortOrder 1, SECOND is sortOrder 2.
    await request(app).patch('/api/assets/us_equity_vti').send({ sortOrder: 2 }).expect(200);
    const { body } = await request(app).patch(`/api/assets/${secondId}`).send({ sortOrder: 1 }).expect(200);

    const usEquityAssetIds = (body as PortfolioState).sleeves
      .find((s) => s.id === 'us_equity')!
      .assets.map((a) => a.id);
    expect(usEquityAssetIds).toEqual([secondId, 'us_equity_vti']);
  });

  it('404s on an unknown id', async () => {
    const { body } = await request(app).patch('/api/assets/nope').send({ label: 'X' }).expect(404);
    expect(body.error).toBe('no asset with that id');
  });

  it('rejects an empty patch body', async () => {
    await request(app).patch('/api/assets/us_equity_vti').send({}).expect(400);
  });
});

describe('DELETE /api/assets/:id', () => {
  it('deletes a fresh asset with no holdings/history', async () => {
    const { body: created } = await request(app)
      .post('/api/assets')
      .send({ sleeveId: 'cad_bonds', ticker: 'ZAG', weightBps: 100 })
      .expect(201);
    const newId = (created as PortfolioState).sleeves
      .flatMap((s) => s.assets)
      .find((a) => a.ticker === 'ZAG')!.id;

    await request(app).delete(`/api/assets/${newId}`).expect(200);

    const { body } = await request(app).get('/api/portfolio').expect(200);
    expect((body as PortfolioState).sleeves.flatMap((s) => s.assets).find((a) => a.id === newId)).toBeUndefined();
  });

  it('refuses to delete an asset with nonzero holdings, mentioning the ticker and amount', async () => {
    await invest(1_000_000).expect(200);

    const { body } = await request(app).delete('/api/assets/us_equity_vti').expect(409);
    expect(body.error).toMatch(/VTI/);
    expect(body.error).toMatch(/\$/);
  });

  it('refuses to delete an asset with investment history even once holdings are zeroed', async () => {
    await invest(1_000_000).expect(200);
    await request(app)
      .put('/api/holdings')
      .send({ holdings: { us_equity_vti: 0 } })
      .expect(200);

    const { body } = await request(app).delete('/api/assets/us_equity_vti').expect(409);
    expect(body.error).toMatch(/history/);
  });

  it('404s on an unknown id', async () => {
    const { body } = await request(app).delete('/api/assets/nope').expect(404);
    expect(body.error).toBe('no asset with that id');
  });
});

describe('POST /api/preview', () => {
  it('reports the same split as investing, without writing anything', async () => {
    const { body: preview } = await request(app)
      .post('/api/preview')
      .send({ amountCents: 1_000_000 })
      .expect(200);

    const { body: after } = await request(app).get('/api/portfolio').expect(200);
    expect((after as PortfolioState).totalCents).toBe(0);

    const { body: executed } = await invest(1_000_000).expect(200);
    expect(assetAmounts(preview as AllocationPlan)).toEqual(assetAmounts(executed.plan));
  });

  it('refuses to preview when the allocation is incomplete', async () => {
    await db.pool.query("UPDATE sleeves SET target_bps = 4000 WHERE id = 'us_equity'");
    const { body } = await request(app).post('/api/preview').send({ amountCents: 1_000_000 }).expect(400);
    expect(body.error).toMatch(/not 100%/);
  });
});

describe('POST /api/presets/example', () => {
  it('loads the example portfolio into an empty database', async () => {
    await db.reset();
    const { body } = await request(app).post('/api/presets/example').expect(201);

    const portfolio = body as PortfolioState;
    expect(portfolio.accounts).toHaveLength(3);
    expect(portfolio.accounts.map((a) => a.label)).toEqual(['RRSP', 'TFSA', 'Non-registered']);
    expect(portfolio.sleeves).toHaveLength(5);
    expect(portfolio.sleeves.map((s) => s.id)).toEqual(['us_equity', 'cad_bonds', 'cad_equity', 'intl_equity', 'em_equity']);

    const assetCount = portfolio.sleeves.reduce((sum, s) => sum + s.assets.length, 0);
    expect(assetCount).toBe(5);
    for (const sleeve of portfolio.sleeves) {
      expect(sleeve.assets).toHaveLength(1);
    }

    const usEquityAsset = portfolio.sleeves.find((s) => s.id === 'us_equity')!.assets[0]!;
    expect(usEquityAsset.id).toBe('us_equity_vti');
    expect(usEquityAsset.ticker).toBe('VTI');
  });

  it('returns 409 with appropriate message when portfolio is not empty', async () => {
    const { body } = await request(app).post('/api/presets/example').expect(409);
    expect(body.error).toBe('the example portfolio can only be loaded into an empty portfolio');
  });

  it('does not duplicate or modify data when the portfolio is not empty', async () => {
    const { body: before } = await request(app).get('/api/portfolio').expect(200);
    const accountCountBefore = (before as PortfolioState).accounts.length;
    expect(accountCountBefore).toBe(3);

    await request(app).post('/api/presets/example').expect(409);

    const { body: after } = await request(app).get('/api/portfolio').expect(200);
    const accountCountAfter = (after as PortfolioState).accounts.length;
    expect(accountCountAfter).toBe(3);
  });
});
