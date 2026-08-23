import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { createTestDatabase, type TestDatabase } from './test/db';
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
});

const invest = (amountCents: unknown) =>
  request(app).post('/api/invest').send({ amountCents }).set('content-type', 'application/json');

const sleeveAmounts = (plan: AllocationPlan) =>
  Object.fromEntries(plan.lines.map((line) => [line.sleeveId, line.amountCents]));

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

    expect(sleeveAmounts(body.plan)).toEqual({
      us_equity: 450_000,
      cad_bonds: 100_000,
      cad_equity: 200_000,
      intl_equity: 150_000,
      em_equity: 100_000,
    });
    expect(body.portfolio.totalCents).toBe(1_000_000);

    const rows = await db.pool.query('SELECT COUNT(*)::int AS n FROM investment_lines');
    expect(rows.rows[0].n).toBe(5);
  });

  it('keeps sleeve holdings equal to what it reported allocating', async () => {
    await invest(1_000_000).expect(200);
    await invest(333_333).expect(200);

    const { body } = await request(app).get('/api/portfolio').expect(200);
    const portfolio = body as PortfolioState;
    const summed = portfolio.sleeves.reduce((total, sleeve) => total + sleeve.holdingCents, 0);
    expect(summed).toBe(portfolio.totalCents);
    expect(summed).toBe(1_000_000 + 333_333);
  });

  it('routes a later deposit to the underweight sleeves', async () => {
    await request(app)
      .put('/api/holdings')
      .send({ holdings: { us_equity: 900_000, cad_bonds: 0, cad_equity: 0, intl_equity: 0, em_equity: 0 } })
      .expect(200);

    const { body } = await invest(1_000_000).expect(200);
    const amounts = sleeveAmounts(body.plan);

    // US equity is far overweight, so it should be starved in favour of the rest.
    expect(amounts.us_equity).toBe(0);
    expect(amounts.cad_equity).toBeGreaterThan(0);
    expect(body.plan.allocatedCents).toBe(1_000_000);
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
    const amounts = sleeveAmounts(body.plan as AllocationPlan);

    expect(amounts.us_equity).toBe(0);
    expect(amounts.cad_bonds).toBe(0);
    expect(amounts.cad_equity).toBe(0);
    expect(amounts.intl_equity).toBe(0);
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
      .send({ holdings: { em_equity: 0 } })
      .expect(200);

    const { body } = await invest(500_000).expect(200);
    const plan = body.plan as AllocationPlan;
    const amounts = sleeveAmounts(plan);

    // Emerging markets is the only sleeve that can actually be funded. The TFSA
    // sleeves are underweight too, so they still claim a share of the deposit and
    // then have it blocked, which is why the rest comes back as cash.
    expect(amounts.em_equity).toBeGreaterThan(0);
    expect(plan.allocatedCents).toBe(amounts.em_equity);
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

describe('PUT /api/accounts/:id/room', () => {
  it('updates a registered account and recomputes remaining room', async () => {
    await invest(1_000_000).expect(200);
    const { body } = await request(app)
      .put('/api/accounts/rrsp/room')
      .send({ roomLimitCents: 9_900_000 })
      .expect(200);

    const rrsp = (body as PortfolioState).accounts.find((a) => a.id === 'rrsp')!;
    expect(rrsp.roomLimitCents).toBe(9_900_000);
    expect(rrsp.roomRemainingCents).toBe(9_900_000 - rrsp.roomUsedCents);
  });

  it('refuses to set a limit on the unlimited non-registered account', async () => {
    const { body } = await request(app)
      .put('/api/accounts/non_registered/room')
      .send({ roomLimitCents: 100 })
      .expect(404);
    expect(body.error).toBe('no registered account with that id');
  });

  it('404s on an unknown account and rejects a negative limit', async () => {
    await request(app).put('/api/accounts/nope/room').send({ roomLimitCents: 100 }).expect(404);
    await request(app).put('/api/accounts/rrsp/room').send({ roomLimitCents: -1 }).expect(400);
  });
});

describe('PUT /api/holdings', () => {
  it('sets opening balances', async () => {
    const { body } = await request(app)
      .put('/api/holdings')
      .send({ holdings: { us_equity: 123_456, cad_bonds: 1_000 } })
      .expect(200);

    const sleeves = (body as PortfolioState).sleeves;
    expect(sleeves.find((s) => s.id === 'us_equity')!.holdingCents).toBe(123_456);
    expect(sleeves.find((s) => s.id === 'cad_bonds')!.holdingCents).toBe(1_000);
  });

  it('rolls the whole request back when one sleeve id is unknown', async () => {
    // us_equity is valid and comes first; it must not survive the failed request.
    await request(app)
      .put('/api/holdings')
      .send({ holdings: { us_equity: 999_999, not_a_sleeve: 1_000 } })
      .expect(500);

    const { body } = await request(app).get('/api/portfolio').expect(200);
    const usEquity = (body as PortfolioState).sleeves.find((s) => s.id === 'us_equity')!;
    expect(usEquity.holdingCents).toBe(0);
  });

  it('rejects negative and fractional holdings', async () => {
    await request(app).put('/api/holdings').send({ holdings: { us_equity: -1 } }).expect(400);
    await request(app).put('/api/holdings').send({ holdings: { us_equity: 1.5 } }).expect(400);
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

describe('POST /api/preview', () => {
  it('reports the same split as investing, without writing anything', async () => {
    const { body: preview } = await request(app)
      .post('/api/preview')
      .send({ amountCents: 1_000_000 })
      .expect(200);

    const { body: after } = await request(app).get('/api/portfolio').expect(200);
    expect((after as PortfolioState).totalCents).toBe(0);

    const { body: executed } = await invest(1_000_000).expect(200);
    expect(sleeveAmounts(preview as AllocationPlan)).toEqual(sleeveAmounts(executed.plan));
  });
});
