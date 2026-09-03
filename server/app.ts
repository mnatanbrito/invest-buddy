import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from './db/pool';
import { accounts, assets, investmentLines, investments, sleeves } from './db/schema';
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
import type { InvestmentRecord, PortfolioState } from '../shared/types';

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

const idSchema = z.string().trim().min(1, 'id is required');

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
  prioritizedAccountIds: z
    .array(idSchema)
    .max(MAX_ACCOUNTS, 'too many prioritized accounts')
    .optional()
    .default([]),
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

/** Rejects a deposit that names a prioritized account the portfolio doesn't have. */
function assertKnownPrioritized(portfolio: PortfolioState, ids: string[]): void {
  const known = new Set(portfolio.accounts.map((a) => a.id));
  const missing = ids.find((id) => !known.has(id));
  if (missing !== undefined) {
    throw new HttpError(400, `unknown account in prioritizedAccountIds: ${missing}`);
  }
}

/** Postgres unique-violation SQLSTATE, whether the error is raw from pg or wrapped by Drizzle. */
function uniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null | undefined;
  return (e?.code ?? e?.cause?.code) === '23505';
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
 * Builds the API against a given Drizzle handle. The handle is a parameter rather
 * than a module singleton so tests can point the same routes at a throwaway database.
 */
export function createApp(db: Database): Express {
  const app = express();
  app.use(express.json());

  app.get(
    '/api/portfolio',
    route(async (_req, res) => {
      res.json(await readPortfolio(db));
    }),
  );

  app.post(
    '/api/accounts',
    route(async (req, res) => {
      const body = accountCreateSchema.parse(req.body);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(accounts);
        if (count >= MAX_ACCOUNTS) {
          throw new HttpError(
            409,
            `an account can't be created — the portfolio already has the maximum of ${MAX_ACCOUNTS}`,
          );
        }
        const id = randomUUID();
        const sortOrder = await nextSortOrder(tx, 'accounts', null);
        await tx.insert(accounts).values({
          id,
          label: body.label,
          note: body.note,
          roomLimit: body.roomLimitCents,
          sortOrder,
        });
        return readPortfolio(tx);
      });
      res.status(201).json(portfolio);
    }),
  );

  app.patch(
    '/api/accounts/:id',
    route(async (req, res) => {
      const patch = accountPatchSchema.parse(req.body);
      const accountId = idSchema.parse(req.params.id);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const existing = await tx
          .select({ one: sql`1` })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1);
        if (existing.length === 0) throw new HttpError(404, 'no account with that id');

        const { sortOrder, ...rest } = patch;
        if (sortOrder !== undefined) {
          await resequence(tx, 'accounts', accountId, sortOrder);
        }
        const columns: Partial<{ label: string; note: string; roomLimit: number | null }> = {};
        if (rest.label !== undefined) columns.label = rest.label;
        if (rest.note !== undefined) columns.note = rest.note;
        if (rest.roomLimitCents !== undefined) columns.roomLimit = rest.roomLimitCents;
        if (Object.keys(columns).length > 0) {
          await tx.update(accounts).set(columns).where(eq(accounts.id, accountId));
        }
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );

  app.delete(
    '/api/accounts/:id',
    route(async (req, res) => {
      const accountId = idSchema.parse(req.params.id);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const [row] = await tx
          .select({ label: accounts.label })
          .from(accounts)
          .where(eq(accounts.id, accountId))
          .limit(1);
        if (!row) throw new HttpError(404, 'no account with that id');

        const { holdingCents, hasHistory } = await deleteBlockers(tx, 'account', accountId);
        if (holdingCents > 0) {
          throw new HttpError(
            409,
            `${row.label} holds ${formatCentsForMessage(holdingCents)} across its sleeves — move or zero out its holdings before deleting.`,
          );
        }
        if (hasHistory) {
          throw new HttpError(
            409,
            `${row.label} has past investments recorded — delete isn't allowed once an account has investment history.`,
          );
        }
        await tx.delete(accounts).where(eq(accounts.id, accountId));
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );

  app.post(
    '/api/sleeves',
    route(async (req, res) => {
      const body = sleeveCreateSchema.parse(req.body);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const parent = await tx
          .select({ one: sql`1` })
          .from(accounts)
          .where(eq(accounts.id, body.accountId))
          .limit(1);
        if (parent.length === 0) throw new HttpError(404, 'no account with that id');

        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(sleeves);
        if (count >= MAX_SLEEVES) {
          throw new HttpError(
            409,
            `a sleeve can't be created — the portfolio already has the maximum of ${MAX_SLEEVES}`,
          );
        }

        const id = randomUUID();
        const sortOrder = await nextSortOrder(tx, 'sleeves', body.accountId);
        await tx.insert(sleeves).values({
          id,
          accountId: body.accountId,
          label: body.label,
          targetBps: body.targetBps,
          sortOrder,
        });
        return readPortfolio(tx);
      });
      res.status(201).json(portfolio);
    }),
  );

  app.patch(
    '/api/sleeves/:id',
    route(async (req, res) => {
      const patch = sleevePatchSchema.parse(req.body);
      const sleeveId = idSchema.parse(req.params.id);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const existing = await tx
          .select({ one: sql`1` })
          .from(sleeves)
          .where(eq(sleeves.id, sleeveId))
          .limit(1);
        if (existing.length === 0) throw new HttpError(404, 'no sleeve with that id');

        const { sortOrder, ...rest } = patch;
        if (sortOrder !== undefined) {
          await resequence(tx, 'sleeves', sleeveId, sortOrder);
        }
        const columns: Partial<{ label: string; targetBps: number }> = {};
        if (rest.label !== undefined) columns.label = rest.label;
        if (rest.targetBps !== undefined) columns.targetBps = rest.targetBps;
        if (Object.keys(columns).length > 0) {
          await tx.update(sleeves).set(columns).where(eq(sleeves.id, sleeveId));
        }
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );

  app.delete(
    '/api/sleeves/:id',
    route(async (req, res) => {
      const sleeveId = idSchema.parse(req.params.id);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const [row] = await tx
          .select({ label: sleeves.label })
          .from(sleeves)
          .where(eq(sleeves.id, sleeveId))
          .limit(1);
        if (!row) throw new HttpError(404, 'no sleeve with that id');

        const { holdingCents, hasHistory } = await deleteBlockers(tx, 'sleeve', sleeveId);
        if (holdingCents > 0) {
          throw new HttpError(
            409,
            `${row.label} holds ${formatCentsForMessage(holdingCents)} — move or zero out its holdings before deleting.`,
          );
        }
        if (hasHistory) {
          throw new HttpError(
            409,
            `${row.label} has past investments recorded — delete isn't allowed once a sleeve has investment history.`,
          );
        }
        await tx.delete(sleeves).where(eq(sleeves.id, sleeveId));
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );

  app.post(
    '/api/assets',
    route(async (req, res) => {
      const body = assetCreateSchema.parse(req.body);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const parent = await tx
          .select({ one: sql`1` })
          .from(sleeves)
          .where(eq(sleeves.id, body.sleeveId))
          .limit(1);
        if (parent.length === 0) throw new HttpError(404, 'no sleeve with that id');

        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(assets)
          .where(eq(assets.sleeveId, body.sleeveId));
        if (count >= MAX_ASSETS_PER_SLEEVE) {
          throw new HttpError(
            409,
            `an asset can't be created — this sleeve already has the maximum of ${MAX_ASSETS_PER_SLEEVE}`,
          );
        }

        const id = randomUUID();
        const sortOrder = await nextSortOrder(tx, 'assets', body.sleeveId);
        try {
          await tx.insert(assets).values({
            id,
            sleeveId: body.sleeveId,
            ticker: body.ticker,
            label: body.label,
            weightBps: body.weightBps,
            sortOrder,
          });
        } catch (error) {
          if (uniqueViolation(error)) {
            throw new HttpError(409, `that sleeve already holds ${body.ticker}`);
          }
          throw error;
        }
        return readPortfolio(tx);
      });
      res.status(201).json(portfolio);
    }),
  );

  app.patch(
    '/api/assets/:id',
    route(async (req, res) => {
      const patch = assetPatchSchema.parse(req.body);
      const assetId = idSchema.parse(req.params.id);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const existing = await tx
          .select({ one: sql`1` })
          .from(assets)
          .where(eq(assets.id, assetId))
          .limit(1);
        if (existing.length === 0) throw new HttpError(404, 'no asset with that id');

        const { sortOrder, ...rest } = patch;
        if (sortOrder !== undefined) {
          await resequence(tx, 'assets', assetId, sortOrder);
        }
        const columns: Partial<{ ticker: string; label: string; weightBps: number }> = {};
        if (rest.ticker !== undefined) columns.ticker = rest.ticker;
        if (rest.label !== undefined) columns.label = rest.label;
        if (rest.weightBps !== undefined) columns.weightBps = rest.weightBps;
        if (Object.keys(columns).length > 0) {
          try {
            await tx.update(assets).set(columns).where(eq(assets.id, assetId));
          } catch (error) {
            if (uniqueViolation(error)) {
              throw new HttpError(409, `that sleeve already holds ${rest.ticker}`);
            }
            throw error;
          }
        }
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );

  app.delete(
    '/api/assets/:id',
    route(async (req, res) => {
      const assetId = idSchema.parse(req.params.id);
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const [row] = await tx
          .select({ ticker: assets.ticker })
          .from(assets)
          .where(eq(assets.id, assetId))
          .limit(1);
        if (!row) throw new HttpError(404, 'no asset with that id');

        const { holdingCents, hasHistory } = await deleteBlockers(tx, 'asset', assetId);
        if (holdingCents > 0) {
          throw new HttpError(
            409,
            `${row.ticker} holds ${formatCentsForMessage(holdingCents)} — move or zero out its holdings before deleting.`,
          );
        }
        if (hasHistory) {
          throw new HttpError(
            409,
            `${row.ticker} has past investments recorded — delete isn't allowed once an asset has investment history.`,
          );
        }
        await tx.delete(assets).where(eq(assets.id, assetId));
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );

  app.post(
    '/api/presets/example',
    route(async (_req, res) => {
      const portfolio = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE`);
        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(accounts);
        if (count > 0) {
          throw new HttpError(409, 'the example portfolio can only be loaded into an empty portfolio');
        }
        await insertPortfolio(tx, EXAMPLE_PORTFOLIO);
        return readPortfolio(tx);
      });
      res.status(201).json(portfolio);
    }),
  );

  /** Dry run: what would this deposit do? Changes nothing. */
  app.post(
    '/api/preview',
    route(async (req, res) => {
      const { amountCents, prioritizedAccountIds } = depositSchema.parse(req.body);
      const portfolio = await readPortfolio(db);
      const issue = allocationIssues(portfolio)[0];
      if (issue) throw new HttpError(400, issue.message);
      assertKnownPrioritized(portfolio, prioritizedAccountIds);
      res.json(
        planDeposit(
          toRebalanceUnits(portfolio),
          portfolio.accounts,
          amountCents,
          prioritizedAccountIds,
        ),
      );
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
      const { amountCents, label, prioritizedAccountIds } = depositSchema.parse(req.body);

      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE assets IN SHARE ROW EXCLUSIVE MODE`);

        const portfolio = await readPortfolio(tx);
        const issue = allocationIssues(portfolio)[0];
        if (issue) throw new HttpError(400, issue.message);
        assertKnownPrioritized(portfolio, prioritizedAccountIds);
        const plan = planDeposit(
          toRebalanceUnits(portfolio),
          portfolio.accounts,
          amountCents,
          prioritizedAccountIds,
        );

        const [inv] = await tx
          .insert(investments)
          .values({
            label,
            requestedCents: plan.requestedCents,
            allocatedCents: plan.allocatedCents,
            unallocatedCents: plan.unallocatedCents,
          })
          .returning({ id: investments.id });
        const investmentId = inv.id;

        for (const line of plan.lines) {
          await tx.insert(investmentLines).values({
            investmentId,
            assetId: line.assetId,
            // A redirect-recipient line has amountCents > intendedCents (the
            // mix-preserving redirect intentionally routes extra cents here).
            // Store the larger figure so the amounts_non_negative CHECK
            // (intended_cents >= amount_cents) still holds; the unpersisted
            // plan response keeps the true drift intention.
            intendedCents: Math.max(line.intendedCents, line.amountCents),
            amountCents: line.amountCents,
          });
          if (line.amountCents > 0) {
            await tx
              .update(assets)
              .set({ holdingCents: sql`${assets.holdingCents} + ${line.amountCents}` })
              .where(eq(assets.id, line.assetId));
          }
        }

        return { investmentId, plan, portfolio: await readPortfolio(tx) };
      });

      res.json(result);
    }),
  );

  /** Undo the most recent investment, returning both the money and the contribution room. */
  app.post(
    '/api/undo',
    route(async (_req, res) => {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE assets IN SHARE ROW EXCLUSIVE MODE`);

        const [latest] = await tx
          .select({ id: investments.id })
          .from(investments)
          .orderBy(desc(investments.id))
          .limit(1);
        if (!latest) return null;

        await tx.execute(sql`
          UPDATE assets a
             SET holding_cents = GREATEST(0, a.holding_cents - l.amount_cents)
            FROM investment_lines l
           WHERE l.asset_id = a.id AND l.investment_id = ${latest.id}
        `);
        await tx.delete(investments).where(eq(investments.id, latest.id));

        return readPortfolio(tx);
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
      const portfolio = await db.transaction(async (tx) => {
        for (const [assetId, cents] of Object.entries(holdings)) {
          const updated = await tx
            .update(assets)
            .set({ holdingCents: cents })
            .where(eq(assets.id, assetId));
          if ((updated.rowCount ?? 0) === 0) throw new HttpError(404, `unknown asset: ${assetId}`);
        }
        return readPortfolio(tx);
      });
      res.json(portfolio);
    }),
  );

  app.get(
    '/api/history',
    route(async (_req, res) => {
      const result = await db.execute(sql`
        SELECT i.id,
               i.label             AS "label",
               i.requested_cents   AS "requestedCents",
               i.allocated_cents   AS "allocatedCents",
               i.unallocated_cents AS "unallocatedCents",
       to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
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
         LIMIT 50
      `);
      res.json(result.rows as unknown as InvestmentRecord[]);
    }),
  );

  return app;
}
