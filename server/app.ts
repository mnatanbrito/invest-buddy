import express, { type Express, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction } from './db/pool';
import { readPortfolio } from './portfolio';
import { allocationIssues, toRebalanceUnits } from '../shared/allocation';
import { planDeposit } from '../shared/rebalance';
import type { InvestmentRecord } from '../shared/types';

/** Thrown by a handler to short-circuit with a specific status code and message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Cent amounts arrive as integers; anything else is a client bug, not a rounding hint. */
const centsSchema = z
  .number()
  .int('amount must be a whole number of cents')
  .min(0, 'amount cannot be negative');

/**
 * Deposits are declared separately rather than as `centsSchema.positive()`: the
 * base schema's lower bound would fail first on a negative amount and surface
 * Zod's default wording instead of this message.
 */
const depositSchema = z.object({
  amountCents: z
    .number()
    .int('amount must be a whole number of cents')
    .positive('enter an amount greater than zero'),
});

const roomSchema = z.object({
  roomLimitCents: centsSchema.nullable(),
});

const holdingsSchema = z.object({
  holdings: z.record(z.string(), centsSchema),
});

const labelSchema = z
  .string()
  .trim()
  .min(1, 'label is required')
  .max(60, 'label is too long');

const tickerSchema = z
  .string()
  .trim()
  .min(1, 'ticker is required')
  .max(12, 'ticker is too long')
  .transform((s) => s.toUpperCase());

const bpsSchema = z.number().int('must be a whole number').min(0).max(10_000);

const idSchema = z.string().trim().min(1, 'id is required');

const sortSchema = z.number().int().positive();

const noteSchema = z.string().trim().max(500).optional().default('');

export const accountCreateSchema = z.object({
  label: labelSchema,
  note: noteSchema,
  roomLimitCents: centsSchema.nullable().optional().default(null),
});

export const accountPatchSchema = z
  .object({
    label: labelSchema.optional(),
    note: z.string().trim().max(500).optional(),
    roomLimitCents: centsSchema.nullable().optional(),
    sortOrder: sortSchema.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'nothing to update');

export const sleeveCreateSchema = z.object({
  accountId: idSchema,
  label: labelSchema,
  targetBps: bpsSchema,
});

export const sleevePatchSchema = z
  .object({
    label: labelSchema.optional(),
    targetBps: bpsSchema.optional(),
    sortOrder: sortSchema.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'nothing to update');

export const assetCreateSchema = z.object({
  sleeveId: idSchema,
  ticker: tickerSchema,
  label: z.string().trim().max(60).optional().default(''),
  weightBps: bpsSchema,
});

export const assetPatchSchema = z
  .object({
    ticker: tickerSchema.optional(),
    label: z.string().trim().max(60).optional(),
    weightBps: bpsSchema.optional(),
    sortOrder: sortSchema.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, 'nothing to update');

export function buildUpdate(fields: Record<string, unknown>): { setClause: string; values: unknown[] } {
  const entries = Object.entries(fields);
  const values = entries.map(([, value]) => value);
  const setClause = entries.map(([key], index) => `${key} = $${index + 1}`).join(', ');
  return { setClause, values };
}

/** Wraps a handler so thrown errors become JSON instead of an HTML stack page. */
const route =
  (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
    handler(req, res).catch((error: unknown) => {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? 'invalid request' });
        return;
      }
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error(error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'unexpected error' });
    });
  };

/**
 * Builds the API against a given pool. The pool is a parameter rather than a
 * module singleton so tests can point the same routes at a throwaway database.
 */
export function createApp(pool: Pool): Express {
  const app = express();
  app.use(express.json());

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
        const issue = allocationIssues(portfolio)[0];
        if (issue) throw new HttpError(400, issue.message);
        res.json(planDeposit(toRebalanceUnits(portfolio), portfolio.accounts, amountCents));
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

      const result = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE assets IN SHARE ROW EXCLUSIVE MODE');

        const portfolio = await readPortfolio(client);
        const issue = allocationIssues(portfolio)[0];
        if (issue) throw new HttpError(400, issue.message);
        const plan = planDeposit(toRebalanceUnits(portfolio), portfolio.accounts, amountCents);

        const { rows } = await client.query<{ id: number; created_at: Date }>(
          `INSERT INTO investments (requested_cents, allocated_cents, unallocated_cents)
           VALUES ($1, $2, $3) RETURNING id, created_at`,
          [plan.requestedCents, plan.allocatedCents, plan.unallocatedCents],
        );
        const investmentId = rows[0].id;

        for (const line of plan.lines) {
          await client.query(
            `INSERT INTO investment_lines (investment_id, asset_id, intended_cents, amount_cents)
             VALUES ($1, $2, $3, $4)`,
            [investmentId, line.assetId, line.intendedCents, line.amountCents],
          );
          if (line.amountCents > 0) {
            await client.query('UPDATE assets SET holding_cents = holding_cents + $1 WHERE id = $2', [
              line.amountCents,
              line.assetId,
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
      const result = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE assets IN SHARE ROW EXCLUSIVE MODE');

        const { rows } = await client.query<{ id: number }>(
          'SELECT id FROM investments ORDER BY id DESC LIMIT 1',
        );
        if (rows.length === 0) return null;

        const investmentId = rows[0].id;
        await client.query(
          `UPDATE assets a
              SET holding_cents = GREATEST(0, a.holding_cents - l.amount_cents)
             FROM investment_lines l
            WHERE l.asset_id = a.id AND l.investment_id = $1`,
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
      const portfolio = await withTransaction(pool, async (client) => {
        for (const [assetId, cents] of Object.entries(holdings)) {
          const { rowCount } = await client.query('UPDATE assets SET holding_cents = $1 WHERE id = $2', [
            cents,
            assetId,
          ]);
          if (rowCount === 0) throw new Error(`unknown asset: ${assetId}`);
        }
        return readPortfolio(client);
      });
      res.json(portfolio);
    }),
  );

  app.get(
    '/api/history',
    route(async (_req, res) => {
      const { rows } = await pool.query<InvestmentRecord>(
        `SELECT i.id,
                i.requested_cents   AS "requestedCents",
                i.allocated_cents   AS "allocatedCents",
                i.unallocated_cents AS "unallocatedCents",
                i.created_at        AS "createdAt",
                COALESCE(
                  json_agg(
                    json_build_object(
                      'assetId', l.asset_id,
                      'sleeveId', ast.sleeve_id,
                      'intendedCents', l.intended_cents,
                      'amountCents', l.amount_cents
                    ) ORDER BY l.id
                  ) FILTER (WHERE l.id IS NOT NULL),
                  '[]'
                ) AS lines
           FROM investments i
           LEFT JOIN investment_lines l ON l.investment_id = i.id
           LEFT JOIN assets ast ON ast.id = l.asset_id
          GROUP BY i.id
          ORDER BY i.id DESC
          LIMIT 50`,
      );
      res.json(rows);
    }),
  );

  return app;
}
