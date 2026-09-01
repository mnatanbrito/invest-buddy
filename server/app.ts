import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction } from './db/pool';
import { deleteBlockers, nextSortOrder, readPortfolio, resequence } from './portfolio';
import { EXAMPLE_PORTFOLIO, insertPortfolio } from './presets/example';
import {
  allocationIssues,
  MAX_ACCOUNTS,
  MAX_ASSETS_PER_SLEEVE,
  MAX_SLEEVES,
  toRebalanceUnits,
} from '../shared/allocation';
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
  label: z.string().trim().max(60, 'label is too long').optional().default(''),
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

const CENTS_FORMAT = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Server-local formatter for one-off error message strings. Deliberately not shared
 * with the client's `formatCents` (`src/lib/money.ts`) — `server/app.ts` isn't part
 * of `tsconfig.app.json`'s program, so it can't import from `src/`.
 */
function formatCentsForMessage(cents: number): string {
  return CENTS_FORMAT.format(cents / 100);
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

  app.post(
    '/api/accounts',
    route(async (req, res) => {
      const body = accountCreateSchema.parse(req.body);
      const portfolio = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM accounts',
        );
        if (rows[0].count >= MAX_ACCOUNTS) {
          throw new HttpError(
            409,
            `an account can't be created — the portfolio already has the maximum of ${MAX_ACCOUNTS}`,
          );
        }
        const id = randomUUID();
        const sortOrder = await nextSortOrder(client, 'accounts', null);
        await client.query(
          'INSERT INTO accounts (id, label, note, room_limit, sort_order) VALUES ($1, $2, $3, $4, $5)',
          [id, body.label, body.note, body.roomLimitCents, sortOrder],
        );
        return readPortfolio(client);
      });
      res.status(201).json(portfolio);
    }),
  );

  app.patch(
    '/api/accounts/:id',
    route(async (req, res) => {
      const patch = accountPatchSchema.parse(req.body);
      const accountId = idSchema.parse(req.params.id);
      const portfolio = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
        if (rows.length === 0) throw new HttpError(404, 'no account with that id');

        const { sortOrder, ...rest } = patch;
        if (sortOrder !== undefined) {
          await resequence(client, 'accounts', accountId, sortOrder);
        }
        const columns: Record<string, unknown> = {};
        if (rest.label !== undefined) columns.label = rest.label;
        if (rest.note !== undefined) columns.note = rest.note;
        if (rest.roomLimitCents !== undefined) columns.room_limit = rest.roomLimitCents;
        if (Object.keys(columns).length > 0) {
          const { setClause, values } = buildUpdate(columns);
          await client.query(`UPDATE accounts SET ${setClause} WHERE id = $${values.length + 1}`, [
            ...values,
            accountId,
          ]);
        }
        return readPortfolio(client);
      });
      res.json(portfolio);
    }),
  );

  app.delete(
    '/api/accounts/:id',
    route(async (req, res) => {
      const accountId = idSchema.parse(req.params.id);
      const portfolio = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query<{ label: string }>('SELECT label FROM accounts WHERE id = $1', [
          accountId,
        ]);
        if (rows.length === 0) throw new HttpError(404, 'no account with that id');
        const label = rows[0].label;

        const { holdingCents, hasHistory } = await deleteBlockers(client, 'account', accountId);
        if (holdingCents > 0) {
          throw new HttpError(
            409,
            `${label} holds ${formatCentsForMessage(holdingCents)} across its sleeves — move or zero out its holdings before deleting.`,
          );
        }
        if (hasHistory) {
          throw new HttpError(
            409,
            `${label} has past investments recorded — delete isn't allowed once an account has investment history.`,
          );
        }
        await client.query('DELETE FROM accounts WHERE id = $1', [accountId]);
        return readPortfolio(client);
      });
      res.json(portfolio);
    }),
  );

  app.post(
    '/api/sleeves',
    route(async (req, res) => {
      const body = sleeveCreateSchema.parse(req.body);
      const portfolio = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE');

        const parent = await client.query('SELECT 1 FROM accounts WHERE id = $1', [body.accountId]);
        if (parent.rows.length === 0) throw new HttpError(404, 'no account with that id');

        const { rows } = await client.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM sleeves',
        );
        if (rows[0].count >= MAX_SLEEVES) {
          throw new HttpError(
            409,
            `a sleeve can't be created — the portfolio already has the maximum of ${MAX_SLEEVES}`,
          );
        }

        const id = randomUUID();
        const sortOrder = await nextSortOrder(client, 'sleeves', body.accountId);
        await client.query(
          'INSERT INTO sleeves (id, account_id, label, target_bps, sort_order) VALUES ($1, $2, $3, $4, $5)',
          [id, body.accountId, body.label, body.targetBps, sortOrder],
        );
        return readPortfolio(client);
      });
      res.status(201).json(portfolio);
    }),
  );

  app.patch(
    '/api/sleeves/:id',
    route(async (req, res) => {
      const patch = sleevePatchSchema.parse(req.body);
      const sleeveId = idSchema.parse(req.params.id);
      const portfolio = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query('SELECT 1 FROM sleeves WHERE id = $1', [sleeveId]);
        if (rows.length === 0) throw new HttpError(404, 'no sleeve with that id');

        const { sortOrder, ...rest } = patch;
        if (sortOrder !== undefined) {
          await resequence(client, 'sleeves', sleeveId, sortOrder);
        }
        const columns: Record<string, unknown> = {};
        if (rest.label !== undefined) columns.label = rest.label;
        if (rest.targetBps !== undefined) columns.target_bps = rest.targetBps;
        if (Object.keys(columns).length > 0) {
          const { setClause, values } = buildUpdate(columns);
          await client.query(`UPDATE sleeves SET ${setClause} WHERE id = $${values.length + 1}`, [
            ...values,
            sleeveId,
          ]);
        }
        return readPortfolio(client);
      });
      res.json(portfolio);
    }),
  );

  app.delete(
    '/api/sleeves/:id',
    route(async (req, res) => {
      const sleeveId = idSchema.parse(req.params.id);
      const portfolio = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query<{ label: string }>('SELECT label FROM sleeves WHERE id = $1', [
          sleeveId,
        ]);
        if (rows.length === 0) throw new HttpError(404, 'no sleeve with that id');
        const label = rows[0].label;

        const { holdingCents, hasHistory } = await deleteBlockers(client, 'sleeve', sleeveId);
        if (holdingCents > 0) {
          throw new HttpError(
            409,
            `${label} holds ${formatCentsForMessage(holdingCents)} — move or zero out its holdings before deleting.`,
          );
        }
        if (hasHistory) {
          throw new HttpError(
            409,
            `${label} has past investments recorded — delete isn't allowed once a sleeve has investment history.`,
          );
        }
        await client.query('DELETE FROM sleeves WHERE id = $1', [sleeveId]);
        return readPortfolio(client);
      });
      res.json(portfolio);
    }),
  );

  app.post(
    '/api/assets',
    route(async (req, res) => {
      const body = assetCreateSchema.parse(req.body);
      const portfolio = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE');

        const parent = await client.query('SELECT 1 FROM sleeves WHERE id = $1', [body.sleeveId]);
        if (parent.rows.length === 0) throw new HttpError(404, 'no sleeve with that id');

        const { rows } = await client.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM assets WHERE sleeve_id = $1',
          [body.sleeveId],
        );
        if (rows[0].count >= MAX_ASSETS_PER_SLEEVE) {
          throw new HttpError(
            409,
            `an asset can't be created — this sleeve already has the maximum of ${MAX_ASSETS_PER_SLEEVE}`,
          );
        }

        const id = randomUUID();
        const sortOrder = await nextSortOrder(client, 'assets', body.sleeveId);
        try {
          await client.query(
            'INSERT INTO assets (id, sleeve_id, ticker, label, weight_bps, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
            [id, body.sleeveId, body.ticker, body.label, body.weightBps, sortOrder],
          );
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new HttpError(409, `that sleeve already holds ${body.ticker}`);
          }
          throw error;
        }
        return readPortfolio(client);
      });
      res.status(201).json(portfolio);
    }),
  );

  app.patch(
    '/api/assets/:id',
    route(async (req, res) => {
      const patch = assetPatchSchema.parse(req.body);
      const assetId = idSchema.parse(req.params.id);
      const portfolio = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query('SELECT 1 FROM assets WHERE id = $1', [assetId]);
        if (rows.length === 0) throw new HttpError(404, 'no asset with that id');

        const { sortOrder, ...rest } = patch;
        if (sortOrder !== undefined) {
          await resequence(client, 'assets', assetId, sortOrder);
        }
        const columns: Record<string, unknown> = {};
        if (rest.ticker !== undefined) columns.ticker = rest.ticker;
        if (rest.label !== undefined) columns.label = rest.label;
        if (rest.weightBps !== undefined) columns.weight_bps = rest.weightBps;
        if (Object.keys(columns).length > 0) {
          const { setClause, values } = buildUpdate(columns);
          try {
            await client.query(`UPDATE assets SET ${setClause} WHERE id = $${values.length + 1}`, [
              ...values,
              assetId,
            ]);
          } catch (error) {
            if ((error as { code?: string }).code === '23505') {
              throw new HttpError(409, `that sleeve already holds ${rest.ticker}`);
            }
            throw error;
          }
        }
        return readPortfolio(client);
      });
      res.json(portfolio);
    }),
  );

  app.delete(
    '/api/assets/:id',
    route(async (req, res) => {
      const assetId = idSchema.parse(req.params.id);
      const portfolio = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query<{ ticker: string }>('SELECT ticker FROM assets WHERE id = $1', [
          assetId,
        ]);
        if (rows.length === 0) throw new HttpError(404, 'no asset with that id');
        const ticker = rows[0].ticker;

        const { holdingCents, hasHistory } = await deleteBlockers(client, 'asset', assetId);
        if (holdingCents > 0) {
          throw new HttpError(
            409,
            `${ticker} holds ${formatCentsForMessage(holdingCents)} — move or zero out its holdings before deleting.`,
          );
        }
        if (hasHistory) {
          throw new HttpError(
            409,
            `${ticker} has past investments recorded — delete isn't allowed once an asset has investment history.`,
          );
        }
        await client.query('DELETE FROM assets WHERE id = $1', [assetId]);
        return readPortfolio(client);
      });
      res.json(portfolio);
    }),
  );

  app.post(
    '/api/presets/example',
    route(async (_req, res) => {
      const portfolio = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM accounts');
        if (rows[0].count > 0) {
          throw new HttpError(409, 'the example portfolio can only be loaded into an empty portfolio');
        }
        await insertPortfolio(client, EXAMPLE_PORTFOLIO);
        return readPortfolio(client);
      });
      res.status(201).json(portfolio);
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
      const { amountCents, label } = depositSchema.parse(req.body);

      const result = await withTransaction(pool, async (client) => {
        await client.query('LOCK TABLE assets IN SHARE ROW EXCLUSIVE MODE');

        const portfolio = await readPortfolio(client);
        const issue = allocationIssues(portfolio)[0];
        if (issue) throw new HttpError(400, issue.message);
        const plan = planDeposit(toRebalanceUnits(portfolio), portfolio.accounts, amountCents);

        const { rows } = await client.query<{ id: number; created_at: Date }>(
          `INSERT INTO investments (label, requested_cents, allocated_cents, unallocated_cents)
           VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
          [label, plan.requestedCents, plan.allocatedCents, plan.unallocatedCents],
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
          if (rowCount === 0) throw new HttpError(404, `unknown asset: ${assetId}`);
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
                i.label             AS "label",
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
