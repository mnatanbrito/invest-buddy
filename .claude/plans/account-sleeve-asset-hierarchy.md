## Progress

- [x] **Stage 1 — Model + engine + read paths** (this PR/commit `fc5bdeb`): schema rewrite, `presets/example.ts`, `server/test/db.ts` (`loadExample`), `shared/types.ts`, `shared/rebalance.ts`, `shared/allocation.ts` (new), `server/portfolio.ts` rewrite (incl. `deleteBlockers`), existing endpoints re-keyed to assets in `server/app.ts`, minimal client edits to compile. `layout.ts` deliberately left on its old fixed-3-panel geometry (Stage 6 work).
  - `pnpm typecheck` and `pnpm lint` verified green.
  - `pnpm test`, `pnpm db:reset && pnpm dev` **verified green** (commit `94ec956`) — the earlier macOS Gatekeeper/esbuild blocker did not recur on this machine. Verification surfaced one real bug, now fixed: `readPortfolio`'s flat sleeves/assets queries ordered only by their own `sort_order, id` without joining through the parent chain, so rows from different accounts/sleeves could interleave instead of staying grouped (`sort_order` resets to 1 per parent in `insertPortfolio`). Fixed by joining sleeves→accounts and assets→sleeves→accounts in the `ORDER BY`. All 95 tests pass; `pnpm dev` confirmed serving the empty-portfolio state on both `:3001` (API) and `:5173` (web) without crashing.
- [x] **Stage 2 — CRUD API** (commits `e346c4b`..`f2e3d2f`, via superpowers:subagent-driven-development, 4 tasks): `buildUpdate`/`resequence` (`nextSortOrder`/`HttpError`/`route()` error handling already existed from Stage 1), Zod create/patch schemas for all 3 levels, all 9 CRUD endpoints (account/sleeve/asset × create/patch/delete) with cap enforcement (portfolio-wide for accounts and sleeves, per-sleeve for assets — deliberately different scopes, both verified by discriminating tests), parent-existence checks, duplicate-ticker 409 via Postgres `23505`, delete-blocked-by-holdings vs delete-blocked-by-history 409s. Full `server/api.test.ts` coverage (46 new tests). All tasks reviewed clean, one fix round in Task 1 (a patch-schema field carried a stray default that could've silently blanked account notes — caught before any endpoint used it). `pnpm typecheck`/`pnpm lint`/`pnpm test` green (137/137).
- [x] **Stage 3 — Preset endpoint** (commit `d66d8bf`, via superpowers:subagent-driven-development): `POST /api/presets/example`, transactional empty-check + 409, reuses `insertPortfolio`/`EXAMPLE_PORTFOLIO`. 3 new tests, review clean. `pnpm typecheck`/`pnpm test` green (140/140).
- [x] **Stage 4 — Empty state + preset button** (commit `16a5aaf`, via superpowers:subagent-driven-development): `api.loadExample()`, `EmptyState.tsx` (scope ruling: "Load example portfolio" CTA only — the plan's earlier prose mentioned an "Add your first account" CTA opening `AccountDialog`, but that component belongs to Stage 5 per the plan's own Sequencing section, so it's deferred there), `App.tsx` empty-accounts branch. Browser-verified end-to-end (empty state → load example → normal 3-account view). `pnpm typecheck`/`pnpm lint`/`pnpm build`/`pnpm test` green (140/140).
- [ ] Stage 5 — The editor (`PortfolioEditor` + cards/rows + 3 dialogs + `DeleteEntityButton` + `editor.ts`/`editor.test.ts` + plan/edit toggle + disabled-Invest messaging; delete `SettingsDialog.tsx`)
- [ ] Stage 6 — Dynamic diagram (`layout.ts`/`AllocationDiagram.tsx` rewrite + generalized `layout.test.ts`)
- [ ] Stage 7 (optional) — component tests (jsdom + `@testing-library/react`)

Next step on pickup: run `pnpm install && pnpm typecheck && pnpm lint && pnpm db:reset && pnpm test`, then `pnpm dev` and walk the empty-state flow by hand (see "Verification" below), before starting Stage 2.

---

# Issue #6 — User-editable Account → Sleeve → Asset hierarchy

## Context

The app currently hardcodes 3 accounts and 5 sleeves in `server/db/seed.sql`, with each sleeve carrying a free-text `tickers` string (e.g. `"VTI or ITOT"`) instead of a real, distinct holding. Changing the account structure, sleeve set, or tickers today requires editing `seed.sql` and resetting the database — there's no in-app way to do it. [GitHub issue #6](https://github.com/mnatanbrito/invest-buddy/issues/6) asks for a fully user-editable three-level hierarchy — **Account → Sleeve → Asset** — built from an empty state, with full CRUD at every level, while keeping the existing drift-aware rebalancing engine, contribution-room capping, and deposit history intact. The original hardcoded 55/35/10 portfolio becomes an optional one-click preset rather than a forced seed.

This is a breaking schema change with no migration path (personal-use app, no production data to preserve): `schema.sql` is rewritten from scratch and `seed.sql` is deleted.

Two decisions confirmed with the user before finalizing this plan:
- **Deletes are blocked whenever the entity ever appears in investment history** (`investment_lines`), not just when it currently holds nonzero cents. This means `investment_lines` FKs to `assets` use `ON DELETE RESTRICT`, not `CASCADE` — history is never silently erased by a delete.
- **UI**: keep the existing SVG diagram as a read-only "Plan" visualization (deposit flow animation untouched) and add a separate HTML card-based "Edit" view for all CRUD. An alternative — making the SVG diagram itself inline-editable — was considered and rejected as higher-risk for this pass; it's documented in the Appendix below in case it's worth revisiting later.

## Data model

```
Account { id, label, note, roomLimitCents: number | null, sortOrder }   // unchanged shape, now full CRUD
Sleeve  { id, accountId, label, targetBps, sortOrder }                   // drops `tickers`; targetBps = share of WHOLE portfolio, bps
Asset   { id, sleeveId, ticker, label, weightBps, holdingCents, sortOrder } // NEW leaf; weightBps = share WITHIN parent sleeve
```

`sleeve.holdingCents` and `account.holdingCents` become derived rollups (sum of descendant assets), not stored columns. Caps: max 10 accounts total, max 10 sleeves total (portfolio-wide), max 10 assets per sleeve. Cross-entity sum invariants (sleeve targets sum to 10000; each sleeve's asset weights sum to 10000) are **not** enforced at write time — only checked (400/disabled) when previewing/executing a deposit.

## Database — `server/db/schema.sql` (rewrite)

Drop order: `investment_lines`, `investments`, `assets`, `sleeves`, `accounts`.

```sql
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  label       TEXT   NOT NULL,
  note        TEXT   NOT NULL DEFAULT '',
  room_limit  BIGINT,                      -- NULL = unlimited
  sort_order  INT    NOT NULL,
  CONSTRAINT account_label_present   CHECK (btrim(label) <> ''),
  CONSTRAINT room_limit_non_negative CHECK (room_limit IS NULL OR room_limit >= 0)
);

CREATE TABLE sleeves (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  target_bps  INT  NOT NULL,               -- share of the WHOLE portfolio
  sort_order  INT  NOT NULL,
  CONSTRAINT sleeve_label_present CHECK (btrim(label) <> ''),
  CONSTRAINT target_bps_valid     CHECK (target_bps BETWEEN 0 AND 10000)
);
CREATE INDEX sleeves_account_idx ON sleeves (account_id);

CREATE TABLE assets (
  id            TEXT   PRIMARY KEY,
  sleeve_id     TEXT   NOT NULL REFERENCES sleeves(id) ON DELETE CASCADE,
  ticker        TEXT   NOT NULL,
  label         TEXT   NOT NULL DEFAULT '',
  weight_bps    INT    NOT NULL,           -- share WITHIN the parent sleeve
  holding_cents BIGINT NOT NULL DEFAULT 0, -- the only stored holding figure; sleeve/account totals are derived
  sort_order    INT    NOT NULL,
  CONSTRAINT asset_ticker_present CHECK (btrim(ticker) <> ''),
  CONSTRAINT weight_bps_valid     CHECK (weight_bps BETWEEN 0 AND 10000),
  CONSTRAINT holding_non_negative CHECK (holding_cents >= 0),
  CONSTRAINT asset_ticker_unique_in_sleeve UNIQUE (sleeve_id, ticker)
);
CREATE INDEX assets_sleeve_idx ON assets (sleeve_id);

-- investments: unchanged

CREATE TABLE investment_lines (
  id             SERIAL PRIMARY KEY,
  investment_id  INT    NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  asset_id       TEXT   NOT NULL REFERENCES assets(id),      -- RESTRICT (default): an asset that ever appears
                                                              -- in history can never be deleted, only edited
  intended_cents BIGINT NOT NULL,
  amount_cents   BIGINT NOT NULL,
  CONSTRAINT amounts_non_negative CHECK (amount_cents >= 0 AND intended_cents >= amount_cents),
  UNIQUE (investment_id, asset_id)
);
CREATE INDEX investment_lines_investment_idx ON investment_lines (investment_id);
CREATE INDEX investment_lines_asset_idx      ON investment_lines (asset_id);
```

Caps and sum invariants stay out of SQL (checked in `app.ts`/`shared/allocation.ts`, not constraints). Map Postgres `23505` on `asset_ticker_unique_in_sleeve` → 409 "that sleeve already holds TICKER".

Because deletes are now RESTRICT-on-history rather than cascade-on-holdings, the delete-guard check must look at **both**: current descendant `holding_cents > 0` (money would be discarded) **and** any row in `investment_lines` for a descendant asset (history would be orphaned/blocked by the FK anyway — better to surface a clear 409 message than let Postgres raise a raw FK-violation error).

### Files to change alongside
- Delete `server/db/seed.sql`.
- `package.json` → `"db:reset": "psql -d invest_buddy -v ON_ERROR_STOP=1 -f server/db/schema.sql"`.
- `server/test/db.ts` → drop `seedSql` entirely; `reset()` becomes schema-only; add `export async function loadExample(pool: Pool): Promise<void>` wrapping `insertPortfolio`.

### `server/presets/example.ts` (new)

```ts
export interface PresetAsset  { id: string; ticker: string; label: string; weightBps: number }
export interface PresetSleeve { id: string; label: string; targetBps: number; assets: PresetAsset[] }
export interface PresetAccount{ id: string; label: string; note: string;
                                roomLimitCents: number | null; sleeves: PresetSleeve[] }

export const EXAMPLE_PORTFOLIO: PresetAccount[]
export async function insertPortfolio(client: PoolClient, accounts: PresetAccount[]): Promise<void>
```

Data (stable slug ids; first ticker of each old free-text pair becomes the single asset per sleeve, `weightBps: 10000`, `holding_cents: 0`):

| account | room | sleeve | targetBps | asset |
|---|---|---|---|---|
| `rrsp` "RRSP" | 5,000,000 | `us_equity` "US total market" | 4500 | `us_equity_vti` VTI |
| | | `cad_bonds` "Canadian bonds" | 1000 | `cad_bonds_vab` VAB |
| `tfsa` "TFSA" | 2,500,000 | `cad_equity` "Canadian equity" | 2000 | `cad_equity_vcn` VCN |
| | | `intl_equity` "International EAFE" | 1500 | `intl_equity_xef` XEF |
| `non_registered` | null | `em_equity` "Emerging markets" | 1000 | `em_equity_vee` VEE |

`insertPortfolio` assumes an empty database (the endpoint enforces that) — no `ON CONFLICT` needed.

## `shared/types.ts`

```ts
export interface Account {
  id: string; label: string; note: string;
  roomLimitCents: number | null; roomUsedCents: number; roomRemainingCents: number | null;
  holdingCents: number;   // DERIVED: sum of descendant asset holdings
  sortOrder: number;
}

export interface Asset {
  id: string; sleeveId: string; ticker: string; label: string;
  weightBps: number;              // share within the parent sleeve
  holdingCents: number;
  effectiveTargetBps: number;     // DERIVED, display only: floor(sleeve.targetBps * weightBps / 10000)
  actualBps: number;              // of the whole portfolio
  driftBps: number;               // actualBps - effectiveTargetBps
  sortOrder: number;
}

export interface Sleeve {
  id: string; accountId: string; label: string;
  targetBps: number;              // share of the WHOLE portfolio
  sortOrder: number;
  assets: Asset[];                // ordered by sortOrder
  holdingCents: number;           // DERIVED
  actualBps: number; driftBps: number;
  assetWeightTotalBps: number;    // DERIVED: sum of assets[].weightBps
}

export interface PortfolioState {
  accounts: Account[];
  sleeves: Sleeve[];               // flat, nested assets; ordered by sortOrder
  totalCents: number;
}

export interface AllocationLine {
  assetId: string;                 // NEW — the unit of allocation
  sleeveId: string;                // derived, for display grouping
  accountId: string;
  intendedCents: number; amountCents: number; blockedCents: number;
}

// AllocationPlan: unchanged

export interface InvestmentRecord {
  // ...unchanged fields...
  lines: { assetId: string; sleeveId: string; intendedCents: number; amountCents: number }[];
}
```

`Sleeve.tickers` is removed. Sleeves stay flat-with-nested-assets (not nested under accounts) — matches the issue and avoids a flatten step in `layoutDiagram`/`HistoryPanel`/client `planDeposit`.

## `shared/rebalance.ts`

`apportion()` and `actualBps()` stay untouched. Only the unit type and weight scale change.

```ts
const BPS = 10_000n;
export const WEIGHT_SCALE = BPS * BPS; // 100_000_000n — sleeve.targetBps * asset.weightBps lands on this scale

export interface RebalanceUnit {
  id: string;        // assetId
  sleeveId: string; accountId: string;
  targetWeight: number;   // sleeve.targetBps * asset.weightBps, in [0, 100_000_000]
  holdingCents: number;
}
// RebalanceAccount: unchanged

export function effectiveWeight(sleeveTargetBps: number, assetWeightBps: number): number;
export function effectiveTargetBps(sleeveTargetBps: number, assetWeightBps: number): number; // display only

export function planDeposit(
  units: RebalanceUnit[], accounts: RebalanceAccount[], depositCents: number,
): AllocationPlan;
```

Body changes are mechanical: `needs[i] = clamp0(BigInt(u.targetWeight) * totalAfter - BigInt(u.holdingCents) * WEIGHT_SCALE)`; room-capping loop unchanged except `sleeves`→`units`; line construction adds `assetId: u.id`. `RebalanceSleeve` is deleted (only 3 call sites, no back-compat alias needed).

## `shared/allocation.ts` (new, pure)

```ts
export const MAX_ACCOUNTS = 10, MAX_SLEEVES = 10, MAX_ASSETS_PER_SLEEVE = 10;

export function sleeveTargetTotalBps(sleeves: Sleeve[]): number;
export function assetWeightTotalBps(assets: Pick<Asset, 'weightBps'>[]): number;

export type AllocationIssue =
  | { kind: 'no-accounts'; message: string }
  | { kind: 'sleeve-targets'; totalBps: number; message: string }
  | { kind: 'sleeve-assets'; sleeveId: string; totalBps: number; message: string };

export function allocationIssues(portfolio: PortfolioState): AllocationIssue[];
export function isFullyAllocated(portfolio: PortfolioState): boolean;
export function toRebalanceUnits(portfolio: PortfolioState): RebalanceUnit[];
```

Rule order: (1) zero accounts, (2) sleeve target sum ≠ 10000, (3) any sleeve whose asset weights don't sum to 10000 (zero-asset sleeve included, since it sums to 0). `toRebalanceUnits` uses `effectiveWeight`.

## `server/portfolio.ts` (rewrite)

Three flat queries assembled in TS (not `json_agg`, to avoid re-hitting the NUMERIC-as-string gotcha on every field instead of just the one `SUM`):

```sql
-- accounts: same LEFT JOIN room_used pattern as today, but joined through assets->sleeves
SELECT a.id, a.label, a.note, a.room_limit, a.sort_order, COALESCE(used.total, 0)::BIGINT AS room_used
  FROM accounts a
  LEFT JOIN (
    SELECT s.account_id, SUM(l.amount_cents)::BIGINT AS total
      FROM investment_lines l JOIN assets ast ON ast.id = l.asset_id JOIN sleeves s ON s.id = ast.sleeve_id
     GROUP BY s.account_id
  ) used ON used.account_id = a.id
 ORDER BY a.sort_order, a.id;

SELECT id, account_id, label, target_bps, sort_order FROM sleeves ORDER BY sort_order, id;
SELECT id, sleeve_id, ticker, label, weight_bps, holding_cents, sort_order FROM assets ORDER BY sort_order, id;
```

`readPortfolio(client)` assembly: group asset rows by `sleeve_id`; `totalCents = Σ all asset.holding_cents` (only place total is computed now); build sleeves with `holdingCents`/`actualBps`/`driftBps`/`assetWeightTotalBps` from their own assets; build accounts with `holdingCents = Σ own sleeves`. Add `, id` tiebreaker to every `ORDER BY` (user-created rows can share `sort_order` transiently).

Delete-guard helper (updated for the RESTRICT-on-history decision — checks holdings **and** history, not holdings alone):

```ts
export type EntityKind = 'account' | 'sleeve' | 'asset';

export interface DeleteBlock { holdingCents: number; hasHistory: boolean }

/** What would stop `id` (of kind `kind`) from being deleted. */
export async function deleteBlockers(client: PoolClient, kind: EntityKind, id: string): Promise<DeleteBlock>;
```

Implementation per kind: one `SELECT COALESCE(SUM(a.holding_cents),0)::BIGINT` scoped to the entity's descendant assets (asset itself / `WHERE sleeve_id=$1` / joined through `sleeves.account_id=$1`), and one `SELECT EXISTS(SELECT 1 FROM investment_lines l JOIN assets a ON a.id=l.asset_id WHERE <same scope>)`. Both run in the same query via a `CROSS JOIN LATERAL` or two sub-selects — either is fine, no perf concern at this scale.

Also add, for the CRUD handlers:
```ts
export async function nextSortOrder(client, table: 'accounts'|'sleeves'|'assets', parentColumn, parentId): Promise<number>;
export async function resequence(client, table, parentColumn, parentId, id: string, sortOrder: number): Promise<void>;
```

## `server/app.ts`

**Infrastructure**: `class HttpError extends Error { constructor(readonly status: number, message: string) }`; extend `route()` to catch `HttpError` before the generic 500 branch (checked before `ZodError` doesn't matter, they're disjoint types); catch Postgres `23505` per-handler where a friendlier message is worth it (duplicate ticker). Add a small `withClient(pool, fn)` helper to cut the repeated connect/finally boilerplate for the new endpoints.

**Schemas** (Zod, following existing `centsSchema`/`depositSchema` style): `labelSchema` (trimmed, 1–60 chars), `tickerSchema` (trimmed, 1–12 chars, uppercased), `bpsSchema` (int 0–10000), `idSchema`, `sortSchema` (positive int). `accountCreateSchema`/`accountPatchSchema`, `sleeveCreateSchema`/`sleevePatchSchema`, `assetCreateSchema`/`assetPatchSchema` — patch schemas `.refine(o => Object.keys(o).length > 0)`. `holdingsSchema` keeps its `Record<string, cents>` shape; keys just mean asset ids now.

**New endpoints** — every write: `withTransaction`, `LOCK TABLE accounts, sleeves, assets IN SHARE ROW EXCLUSIVE MODE` before cap-counting (avoids a race between the count check and the insert), respond with the full `readPortfolio(client)` (matches the existing `PUT /api/holdings` pattern so the client never needs a follow-up GET):

- `POST /api/accounts` — cap check (`COUNT(*) ≥ 10` → 409), `id = randomUUID()`, `sort_order` via `nextSortOrder`, insert.
- `PATCH /api/accounts/:id` — dynamic `SET` via a shared `buildUpdate(fields)` helper (reused by all 3 PATCHes); 404 if `rowCount === 0`; `resequence` if `sortOrder` present.
- `DELETE /api/accounts/:id` — `deleteBlockers(client, 'account', id)`; if `holdingCents > 0` **or** `hasHistory` → 409 with a message distinguishing the two cases (e.g. holdings present: "RRSP holds $1,200.00 across its sleeves — move or zero out its holdings before deleting."; history-only: "RRSP has past investments recorded — delete isn't allowed once an account has investment history."); else delete (cascades sleeves→assets since those FKs stay `ON DELETE CASCADE`; the `investment_lines` RESTRICT is what actually enforces the history rule and this check exists to give a clean 409 instead of a raw FK error).
- `POST /api/sleeves` / `PATCH .../:id` / `DELETE .../:id` — same shape; sleeve cap is portfolio-wide (`COUNT(*) FROM sleeves`, not scoped to the account).
- `POST /api/assets` / `PATCH .../:id` / `DELETE .../:id` — asset cap scoped to `sleeve_id` (`COUNT(*) FROM assets WHERE sleeve_id = $1 ≥ 10`); duplicate ticker → 409 via `23505` catch.
- `POST /api/presets/example` — `SELECT COUNT(*) FROM accounts > 0` → 409 "the example portfolio can only be loaded into an empty portfolio"; else `insertPortfolio(client, EXAMPLE_PORTFOLIO)`.

**Changed endpoints**:
- `POST /api/preview` — after `readPortfolio`, `allocationIssues(portfolio)[0]` → `HttpError(400, issue.message)`; else `planDeposit(toRebalanceUnits(portfolio), portfolio.accounts, amountCents)`.
- `POST /api/invest` — lock `assets` (not `sleeves`); same allocation gate **inside** the transaction after the re-read (so a concurrent edit can't slip an incomplete plan through); insert lines with `asset_id`; `UPDATE assets SET holding_cents = holding_cents + $1 WHERE id = $2`.
- `POST /api/undo` — lock `assets`; update via `investment_lines.asset_id`. No allocation gate — undo must always work regardless of current allocation completeness.
- `PUT /api/holdings` — `UPDATE assets SET holding_cents = $1 WHERE id = $2`; error text `unknown asset: ${id}`.
- `PUT /api/accounts/:id/room` — unchanged.
- `GET /api/history` — join through `assets` to derive `sleeveId`: `LEFT JOIN assets a ON a.id = l.asset_id`, `json_build_object('assetId', l.asset_id, 'sleeveId', a.sleeve_id, ...)`.

## Frontend

Keep the SVG diagram as the read-only "Plan" visualization (deposit flow animation untouched). Add a separate HTML card-based "Edit" view for CRUD.

`src/App.tsx`: `const [view, setView] = useState<'plan' | 'edit'>(...)`, a segmented toggle in the header, three branches: (1) zero accounts → `<EmptyState/>` only; (2) `view === 'plan'` → today's invest form + `AllocationDiagram` + `HistoryPanel`; (3) `view === 'edit'` → `<PortfolioEditor/>`. Default view: `'edit'` when `!isFullyAllocated(portfolio)`, else `'plan'`. Compute `const issues = allocationIssues(portfolio)`; gate client preview (`if (issues.length) return null` before `planDeposit`); `canInvest` requires `issues.length === 0`; show `issues[0].message` next to the disabled Invest button with a link that flips to `'edit'`.

**New files**:
- `src/components/EmptyState.tsx` — "Add your first account" CTA (opens `AccountDialog`) + prominent "Load example portfolio" button (`api.loadExample()`).
- `src/components/editor/PortfolioEditor.tsx` — portfolio-wide running total header, "Add account" (disabled at cap), maps `AccountCard`.
- `src/components/editor/AccountCard.tsx`, `SleeveRow.tsx`, `AssetRow.tsx` — display + edit/delete/reorder at each level, running weight totals colored destructive when ≠ 10000, "Add …" buttons disabled at their cap.
- `src/components/editor/AccountDialog.tsx`, `SleeveDialog.tsx`, `AssetDialog.tsx` — Radix dialogs, create+edit in one component each (mirrors `SettingsDialog`'s "mounted only while open, parse everything before writing anything" pattern).
- `src/components/editor/DeleteEntityButton.tsx` — confirm dialog; on 409 shows the server's message inline (holdings vs. history distinction) instead of closing.
- `src/lib/editor.ts` + `editor.test.ts` — pure helpers: `bpsFromPercentField`/`percentFieldFromBps`, `moveSortOrder`, message formatting helpers reused by the dialogs.

**Deletions**: delete `src/components/SettingsDialog.tsx` (room limit moves into `AccountDialog` via `PATCH`; holdings move into `AssetDialog`). `HistoryPanel.tsx`: key badges off `line.assetId`, look up ticker via a `Map` built from `portfolio.sleeves.flatMap(s => s.assets)`, fall back to the raw id if the asset was since deleted (deletion is now blocked once an asset has history, so this is only a defensive fallback, not an expected case).

**`src/lib/api.ts` additions**: `createAccount/updateAccount/deleteAccount`, `createSleeve/updateSleeve/deleteSleeve`, `createAsset/updateAsset/deleteAsset`, `loadExample()`. Consider attaching `status` to the thrown `Error` in `request()` so `DeleteEntityButton` can distinguish a 409 (show inline) from a network failure (generic toast).

**`src/components/diagram/layout.ts`** — make genuinely dynamic instead of the current fixed-3-panel/1000×660 canvas:

```ts
export interface AssetRowGeometry { asset: Asset; x; y; width; height; centerX; centerY }
export interface BoxGeometry { sleeve: Sleeve; x; y; width; height; centerX; centerY; rows: AssetRowGeometry[] }
export interface PanelGeometry { account: Account; x; y; width; height; centerX; boxes: BoxGeometry[]; targetBps: number; holdingCents: number }
export interface DiagramLayout { canvas: { width: number; height: number }; flowOrigin: { x: number; y: number }; panels: PanelGeometry[] }
export function layoutDiagram(accounts: Account[], sleeves: Sleeve[]): DiagramLayout;
```

Sizing derives from content: `boxHeight(sleeve) = headerHeight + sleeve.assets.length * rowHeight + padBottom`; panel height = max content height across accounts; canvas width = `marginX*2 + n*panelWidth + (n-1)*gap` (floor 1000 so a lone account doesn't render as a sliver). `AllocationDiagram.tsx`: wrap `<svg>` in `<div className="overflow-x-auto">`, set explicit pixel width when the canvas exceeds 1000 so many accounts scroll rather than shrink illegibly; `SleeveBox` drops the `tickers` line and renders one `AssetRow` per asset; preview/flight maps re-key from `sleeveId` to `assetId`; empty-sleeve case renders a muted "No assets yet" line.

## Sequencing

Each stage leaves typecheck/lint/tests green and the app runnable. No compatibility shim — the type changes are visible everywhere at once, so Stage 1 is a deliberately wide, mechanical vertical slice with no new UI.

1. **Model + engine + read paths** — schema rewrite, delete seed.sql, `presets/example.ts`, `server/test/db.ts` update, `shared/types.ts`, `shared/rebalance.ts`, `shared/allocation.ts` (new), `server/portfolio.ts` rewrite (incl. `deleteBlockers`), existing endpoints updated in `server/app.ts`, minimal client edits to compile (App.tsx uses `toRebalanceUnits`, HistoryPanel/SleeveBox/SettingsDialog re-keyed to assets). `layout.ts` stays fixed for now. Verify `pnpm db:reset` + `pnpm dev` renders an empty portfolio without crashing (first time the app ever sees zero accounts).
2. **CRUD API** — `HttpError`, `buildUpdate`/`nextSortOrder`/`resequence`, the 9 CRUD endpoints, full `server/api.test.ts` coverage (create/patch/cap 409/unknown-parent 404/duplicate-ticker 409/delete-blocked-by-holdings 409/delete-blocked-by-history 409/delete-allowed-after-zeroing).
3. **Preset endpoint** — `POST /api/presets/example` + 409-on-nonempty test.
4. **Empty state + preset button** — `api.ts` additions, `EmptyState.tsx`, `App.tsx` empty branch. First user-visible win.
5. **The editor** — `PortfolioEditor` + cards/rows + 3 dialogs + `DeleteEntityButton` + `editor.ts`/`editor.test.ts` + plan/edit toggle + disabled-Invest messaging. Delete `SettingsDialog.tsx`.
6. **Dynamic diagram** — rewrite `layout.ts`/`AllocationDiagram.tsx`; rewrite `layout.test.ts` with generalized invariants (containment, non-overlap, flow origin below every target) over generated trees (1 account; 10 accounts × 1 sleeve; 1 account × 10 sleeves × 10 assets; zero-asset sleeve; zero-sleeve account).
7. **(Optional, only if wanted)** real component tests — add jsdom + `@testing-library/react`, scoped via `vitest.config.ts` `environmentMatchGlobs` so `server/**` stays `node`.

## Test-file inventory

- `shared/rebalance.test.ts` — rewritten fixtures (`unit(id, sleeveId, accountId, sleeveTargetBps, assetWeightBps, holdingCents)`), keep all `apportion` tests, add multi-asset-sleeve and cross-sleeve-same-account cases, extend the 500-trial fuzz to multi-asset trees, add `effectiveWeight`/`effectiveTargetBps` tests including the floor case.
- `shared/allocation.test.ts` (new) — `sleeveTargetTotalBps`, `assetWeightTotalBps`, `allocationIssues` (empty/partial/zero-asset-sleeve/fully-allocated), `toRebalanceUnits`.
- `server/portfolio.test.ts` — extend the BIGINT/NUMERIC regression test to the 3-table join; rollup correctness at both levels; zero-asset/zero-sleeve round-trips; `deleteBlockers` at all 3 levels including the history-only case; empty-DB shape.
- `server/api.test.ts` — `beforeEach` loads the example tree; `sleeveAmounts` → `assetAmounts`; new CRUD describes per level including both delete-blocked variants (holdings vs. history) and delete-allowed-after-zeroing; preview/invest 400 on incomplete allocation while undo/history/holdings still work.
- `server/test/db.ts` — schema-only reset, export `loadExample`.
- `src/components/diagram/layout.test.ts` — rewritten for `DiagramLayout` over generated trees.
- `src/lib/editor.test.ts` (new) — pure editor helpers, exact delete-blocked wording for both cases.

## Watch-outs

- `server/portfolio.test.ts` and other seed-dependent tests need `loadExample` in `beforeEach` now that there's no forced seed.
- The `room_used` aggregate remains the only `SUM` crossing the BIGINT/NUMERIC type-parser boundary — keep the `::BIGINT` cast and its comment.
- `App.tsx`'s client-side preview `planDeposit` call must use the same `toRebalanceUnits` the server uses, or preview and execution can disagree.
- `tsconfig.server.json` has `noUnusedLocals`/`noUnusedParameters` — the wide Stage 1 refactor will trip these on half-removed imports.
- `oxlint --deny-warnings` runs in `pnpm lint`; new `src/components/editor/**` files must satisfy it.
- Deleting an account/sleeve cascades to its children's rows via `ON DELETE CASCADE` on `sleeves.account_id` and `assets.sleeve_id`, but the `deleteBlockers` check must run *before* that cascade is attempted — otherwise a delete blocked by one descendant asset's history would still need to not touch siblings, which it won't as long as the check happens pre-delete inside the same transaction.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm test` green after every stage.
- `pnpm db:reset && pnpm dev` — walk the full flow by hand: empty state → "Load example portfolio" → toggle to Edit view → add an account/sleeve/asset → try to delete a sleeve with holdings (blocked, correct message) → zero it via the asset editor → delete it (succeeds) → invest a deposit, undo it, confirm history and room reflect it → deliberately leave a sleeve's assets not summing to 10000 and confirm Invest is disabled with the right message → switch to Plan view and confirm the diagram renders correctly for an account count other than 3 (e.g. delete one account, or add a 4th).
- Run the existing Vitest suites plus the new ones described above; the rebalance fuzz test doubles as a regression guard on the asset-level math.

## Appendix — deferred alternative: editable SVG diagram

Considered instead of the separate Plan/Edit views: making the existing SVG `AllocationDiagram` itself support inline editing (click a sleeve/asset box to rename or retarget it, drag to reorder, an in-place "+" affordance to add a sleeve/asset without leaving the diagram). Rejected for this pass because it multiplies the implementation risk of an already-nontrivial dynamic-layout rewrite: SVG hit-testing and focus management for text inputs, drag-and-drop reordering with `sortOrder` persistence, and validation messaging would all need to be built inside the SVG coordinate system rather than as ordinary HTML forms, for a UX gain (one cohesive view instead of a toggle) that's real but secondary to shipping correct CRUD first.

If this is worth revisiting later, the natural approach would be: keep `layoutDiagram`'s geometry output as the single source of truth (as in the main plan's Stage 6 rewrite), but render editable `<foreignObject>` HTML inputs positioned at each box's geometry instead of plain `<text>`, add pointer-based drag handlers per box/row that compute a new `sortOrder` from drop position and call the existing `PATCH` endpoints, and add small "+" affordances at each panel/box edge that open the same `AccountDialog`/`SleeveDialog`/`AssetDialog` components already built for the card editor (so the dialogs are shared between both UIs rather than duplicated). This would let the two approaches converge — build the card editor first per the plan above, then optionally layer inline SVG affordances on top of the same dialogs and API calls once the CRUD surface is proven out.
