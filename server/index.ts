import express from 'express';
import { z } from 'zod';
import { pool, withTransaction } from './db/pool';
import { readPortfolio } from './portfolio';
import { planDeposit } from '../shared/rebalance';
import type { InvestmentRecord } from '../shared/types';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 3001);

/** Cent amounts arrive as integers; anything else is a client bug, not a rounding hint. */
const centsSchema = z
  .number()
  .int('amount must be a whole number of cents')
  .nonnegative();

const depositSchema = z.object({
  amountCents: centsSchema.positive('enter an amount greater than zero'),
});

const roomSchema = z.object({
  roomLimitCents: centsSchema.nullable(),
});

const holdingsSchema = z.object({
  holdings: z.record(z.string(), centsSchema),
});

/** Wraps a handler so thrown errors become JSON instead of an HTML stack page. */
const route =
  (handler: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response) => {
    handler(req, res).catch((error: unknown) => {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? 'invalid request' });
        return;
      }
      console.error(error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'unexpected error' });
    });
  };

app.get(
  '/api/portfolio',
  route(async (_req, res) => {
    const client = await pool.connect();
    try {
      res.json(await readPortfolio(client));
    } finally {
      client.release();
    }
  }),
);

/** Dry run: what would this deposit do? Changes nothing. */
app.post(
  '/api/preview',
  route(async (req, res) => {
    const { amountCents } = depositSchema.parse(req.body);
    const client = await pool.connect();
    try {
      const portfolio = await readPortfolio(client);
      res.json(planDeposit(portfolio.sleeves, portfolio.accounts, amountCents));
    } finally {
      client.release();
    }
  }),
);

/**
 * Execute a deposit. Re-plans inside the transaction against freshly locked rows
 * rather than trusting a plan the client computed earlier, so a stale preview can
 * never write the wrong amounts.
 */
app.post(
  '/api/invest',
  route(async (req, res) => {
    const { amountCents } = depositSchema.parse(req.body);

    const result = await withTransaction(async (client) => {
      await client.query('LOCK TABLE sleeves IN SHARE ROW EXCLUSIVE MODE');

      const portfolio = await readPortfolio(client);
      const plan = planDeposit(portfolio.sleeves, portfolio.accounts, amountCents);

      const { rows } = await client.query<{ id: number; created_at: Date }>(
        `INSERT INTO investments (requested_cents, allocated_cents, unallocated_cents)
         VALUES ($1, $2, $3) RETURNING id, created_at`,
        [plan.requestedCents, plan.allocatedCents, plan.unallocatedCents],
      );
      const investmentId = rows[0].id;

      for (const line of plan.lines) {
        await client.query(
          `INSERT INTO investment_lines (investment_id, sleeve_id, intended_cents, amount_cents)
           VALUES ($1, $2, $3, $4)`,
          [investmentId, line.sleeveId, line.intendedCents, line.amountCents],
        );
        if (line.amountCents > 0) {
          await client.query('UPDATE sleeves SET holding_cents = holding_cents + $1 WHERE id = $2', [
            line.amountCents,
            line.sleeveId,
          ]);
        }
      }

      return { investmentId, plan, portfolio: await readPortfolio(client) };
    });

    res.json(result);
  }),
);

/** Undo the most recent investment, returning both the money and the contribution room. */
app.post(
  '/api/undo',
  route(async (_req, res) => {
    const result = await withTransaction(async (client) => {
      await client.query('LOCK TABLE sleeves IN SHARE ROW EXCLUSIVE MODE');

      const { rows } = await client.query<{ id: number }>(
        'SELECT id FROM investments ORDER BY id DESC LIMIT 1',
      );
      if (rows.length === 0) return null;

      const investmentId = rows[0].id;
      await client.query(
        `UPDATE sleeves s
            SET holding_cents = GREATEST(0, s.holding_cents - l.amount_cents)
           FROM investment_lines l
          WHERE l.sleeve_id = s.id AND l.investment_id = $1`,
        [investmentId],
      );
      await client.query('DELETE FROM investments WHERE id = $1', [investmentId]);

      return readPortfolio(client);
    });

    if (result === null) {
      res.status(409).json({ error: 'there is nothing to undo' });
      return;
    }
    res.json(result);
  }),
);

app.put(
  '/api/accounts/:id/room',
  route(async (req, res) => {
    const { roomLimitCents } = roomSchema.parse(req.body);
    const client = await pool.connect();
    try {
      const { rowCount } = await client.query(
        'UPDATE accounts SET room_limit = $1 WHERE id = $2 AND room_limit IS NOT NULL',
        [roomLimitCents, req.params.id],
      );
      if (rowCount === 0) {
        res.status(404).json({ error: 'no registered account with that id' });
        return;
      }
      res.json(await readPortfolio(client));
    } finally {
      client.release();
    }
  }),
);

/** Set opening balances for a portfolio that already exists outside this app. */
app.put(
  '/api/holdings',
  route(async (req, res) => {
    const { holdings } = holdingsSchema.parse(req.body);
    const portfolio = await withTransaction(async (client) => {
      for (const [sleeveId, cents] of Object.entries(holdings)) {
        const { rowCount } = await client.query(
          'UPDATE sleeves SET holding_cents = $1 WHERE id = $2',
          [cents, sleeveId],
        );
        if (rowCount === 0) throw new Error(`unknown sleeve: ${sleeveId}`);
      }
      return readPortfolio(client);
    });
    res.json(portfolio);
  }),
);

app.get(
  '/api/history',
  route(async (_req, res) => {
    const { rows } = await pool.query<InvestmentRecord & { lines: null | InvestmentRecord['lines'] }>(
      `SELECT i.id,
              i.requested_cents   AS "requestedCents",
              i.allocated_cents   AS "allocatedCents",
              i.unallocated_cents AS "unallocatedCents",
              i.created_at        AS "createdAt",
              COALESCE(
                json_agg(
                  json_build_object(
                    'sleeveId', l.sleeve_id,
                    'intendedCents', l.intended_cents,
                    'amountCents', l.amount_cents
                  ) ORDER BY l.id
                ) FILTER (WHERE l.id IS NOT NULL),
                '[]'
              ) AS lines
         FROM investments i
         LEFT JOIN investment_lines l ON l.investment_id = i.id
        GROUP BY i.id
        ORDER BY i.id DESC
        LIMIT 50`,
    );
    res.json(rows);
  }),
);

app.listen(PORT, () => {
  console.log(`invest-buddy api listening on http://localhost:${PORT}`);
});
