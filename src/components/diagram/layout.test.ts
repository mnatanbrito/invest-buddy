import { describe, expect, it } from 'vitest';
import type { Account, Asset, Sleeve } from '@shared/types';
import { layoutDiagram, type DiagramLayout } from './layout';

// ---------------------------------------------------------------------------
// Generators — build variable-shaped trees instead of one hardcoded fixture.
// ---------------------------------------------------------------------------

function makeAccount(id: string, sortOrder: number): Account {
  return {
    id,
    label: `Account ${id}`,
    note: 'Some note text that might wrap across a couple of lines in the panel footer.',
    roomLimitCents: 5_000_000,
    roomUsedCents: 0,
    roomRemainingCents: 5_000_000,
    holdingCents: 0,
    sortOrder,
  };
}

function makeAsset(id: string, sleeveId: string, sortOrder: number, holdingCents = 0): Asset {
  return {
    id,
    sleeveId,
    ticker: id.toUpperCase(),
    label: `Asset ${id}`,
    weightBps: 10_000,
    holdingCents,
    effectiveTargetBps: 0,
    actualBps: 0,
    driftBps: 0,
    sortOrder,
  };
}

function makeSleeve(
  id: string,
  accountId: string,
  targetBps: number,
  sortOrder: number,
  assets: Asset[] = [],
  holdingCents?: number,
): Sleeve {
  return {
    id,
    accountId,
    label: `Sleeve ${id}`,
    targetBps,
    sortOrder,
    assets,
    holdingCents: holdingCents ?? assets.reduce((sum, a) => sum + a.holdingCents, 0),
    actualBps: 0,
    driftBps: 0,
    assetWeightTotalBps: assets.reduce((sum, a) => sum + a.weightBps, 0),
  };
}

/** n accounts, each with `sleevesPerAccount` sleeves, each with `assetsPerSleeve` assets. */
function generateTree(n: number, sleevesPerAccount: number, assetsPerSleeve: number) {
  const accounts: Account[] = [];
  const sleeves: Sleeve[] = [];
  let sleeveSortOrder = 1;

  for (let a = 0; a < n; a++) {
    const accountId = `acct-${a}`;
    accounts.push(makeAccount(accountId, a + 1));

    for (let s = 0; s < sleevesPerAccount; s++) {
      const sleeveId = `${accountId}-sleeve-${s}`;
      const assets: Asset[] = [];
      for (let r = 0; r < assetsPerSleeve; r++) {
        assets.push(makeAsset(`${sleeveId}-asset-${r}`, sleeveId, r + 1, 1_000 * (r + 1)));
      }
      sleeves.push(makeSleeve(sleeveId, accountId, 1000, sleeveSortOrder++, assets));
    }
  }

  return { accounts, sleeves };
}

// ---------------------------------------------------------------------------
// Shared invariant checks — applied to every generated layout below.
// ---------------------------------------------------------------------------

function assertValidLayout(layout: DiagramLayout, accounts: Account[], sleeves: Sleeve[]) {
  const { canvas, flowOrigin, panels } = layout;

  // Panels: order, bounds, no horizontal overlap.
  expect(panels.map((p) => p.account.id)).toEqual(accounts.map((a) => a.id));

  for (const panel of panels) {
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(canvas.width);
  }
  for (let i = 1; i < panels.length; i++) {
    const prev = panels[i - 1];
    expect(panels[i].x).toBeGreaterThanOrEqual(prev.x + prev.width);
  }

  // All panels share the computed max height.
  if (panels.length > 0) {
    const expectedHeight = panels[0].height;
    for (const panel of panels) {
      expect(panel.height).toBe(expectedHeight);
    }
  }

  for (const panel of panels) {
    const ownSleeves = sleeves.filter((s) => s.accountId === panel.account.id);

    // Boxes: order matches this account's sleeves.
    expect(panel.boxes.map((b) => b.sleeve.id)).toEqual(ownSleeves.map((s) => s.id));

    // Boxes: contained within their panel.
    for (const box of panel.boxes) {
      expect(box.x).toBeGreaterThanOrEqual(panel.x);
      expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
      expect(box.y).toBeGreaterThanOrEqual(panel.y);
      expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height);
      // Sensible height: never zero or negative.
      expect(box.height).toBeGreaterThan(0);
    }

    // Boxes: no vertical overlap, stacked in order.
    for (let i = 1; i < panel.boxes.length; i++) {
      const prev = panel.boxes[i - 1];
      expect(panel.boxes[i].y).toBeGreaterThanOrEqual(prev.y + prev.height);
    }

    // Boxes: centered horizontally on the panel; centerY is their own midpoint.
    for (const box of panel.boxes) {
      expect(box.centerX).toBe(panel.centerX);
      expect(box.centerY).toBe(box.y + box.height / 2);
    }

    // Rows: order, containment, non-overlap, centering.
    for (const box of panel.boxes) {
      expect(box.rows.map((r) => r.asset.id)).toEqual(box.sleeve.assets.map((a) => a.id));

      for (const row of box.rows) {
        expect(row.x).toBeGreaterThanOrEqual(box.x);
        expect(row.x + row.width).toBeLessThanOrEqual(box.x + box.width);
        expect(row.y).toBeGreaterThanOrEqual(box.y);
        expect(row.y + row.height).toBeLessThanOrEqual(box.y + box.height);
        expect(row.centerX).toBe(box.centerX);
        expect(row.centerY).toBe(row.y + row.height / 2);
      }

      for (let i = 1; i < box.rows.length; i++) {
        const prev = box.rows[i - 1];
        expect(box.rows[i].y).toBeGreaterThanOrEqual(prev.y + prev.height);
      }
    }

    // Sums.
    expect(panel.targetBps).toBe(ownSleeves.reduce((sum, s) => sum + s.targetBps, 0));
    expect(panel.holdingCents).toBe(ownSleeves.reduce((sum, s) => sum + s.holdingCents, 0));

    // Flow origin sits below every box, so tokens travel upward.
    for (const box of panel.boxes) {
      expect(flowOrigin.y).toBeGreaterThan(box.centerY);
    }
  }

  expect(flowOrigin.x).toBe(canvas.width / 2);
  expect(flowOrigin.y).toBeLessThanOrEqual(canvas.height);
}

describe('layoutDiagram', () => {
  it('handles a single account with no sleeves without crashing', () => {
    const accounts = [makeAccount('solo', 1)];
    const sleeves: Sleeve[] = [];
    const layout = layoutDiagram(accounts, sleeves);

    assertValidLayout(layout, accounts, sleeves);
    expect(layout.canvas.width).toBe(1000); // floor engages: 1 panel is well under 1000
    expect(layout.panels[0].boxes).toEqual([]);
    expect(layout.panels[0].height).toBeGreaterThan(0);
    expect(layout.panels[0].targetBps).toBe(0);
    expect(layout.panels[0].holdingCents).toBe(0);
  });

  it('floors canvas width at 1000 when natural width is well below it', () => {
    // 2 panels at width 304 + gap 28 + margins 32 = 668, well under 1000.
    const { accounts, sleeves } = generateTree(2, 1, 1);
    const naturalWidth = 16 * 2 + 2 * 304 + 1 * 28;
    expect(naturalWidth).toBeLessThan(1000);

    const layout = layoutDiagram(accounts, sleeves);
    assertValidLayout(layout, accounts, sleeves);
    expect(layout.canvas.width).toBe(1000);
  });

  it('scales canvas width past the floor for 10 accounts with 1 sleeve each', () => {
    const { accounts, sleeves } = generateTree(10, 1, 0);
    // Give every other sleeve one asset, to also exercise 0-vs-1-asset sleeves.
    for (let i = 0; i < sleeves.length; i += 2) {
      sleeves[i].assets = [makeAsset(`${sleeves[i].id}-a0`, sleeves[i].id, 1, 500)];
      sleeves[i].holdingCents = 500;
    }

    const naturalWidth = 16 * 2 + 10 * 304 + 9 * 28;
    expect(naturalWidth).toBeGreaterThan(1000);

    const layout = layoutDiagram(accounts, sleeves);
    assertValidLayout(layout, accounts, sleeves);
    // Floor must not clamp when the natural width already exceeds it.
    expect(layout.canvas.width).toBe(naturalWidth);
    expect(layout.panels).toHaveLength(10);
  });

  it('handles a single deep account (10 sleeves x 10 assets) without exponential blowup', () => {
    const { accounts, sleeves } = generateTree(1, 10, 10);

    const start = Date.now();
    const layout = layoutDiagram(accounts, sleeves);
    const elapsedMs = Date.now() - start;

    assertValidLayout(layout, accounts, sleeves);
    expect(layout.panels[0].boxes).toHaveLength(10);
    for (const box of layout.panels[0].boxes) {
      expect(box.rows).toHaveLength(10);
    }
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('gives a zero-asset sleeve a sensible height without breaking sibling stacking', () => {
    const account = makeAccount('mixed', 1);
    const withAssets1 = makeSleeve('s1', account.id, 3000, 1, [
      makeAsset('a1', 's1', 1, 100),
      makeAsset('a2', 's1', 2, 200),
    ]);
    const empty = makeSleeve('s2', account.id, 0, 2, []);
    const withAssets2 = makeSleeve('s3', account.id, 3000, 3, [makeAsset('a3', 's3', 1, 300)]);
    const sleeves = [withAssets1, empty, withAssets2];

    const layout = layoutDiagram([account], sleeves);
    assertValidLayout(layout, [account], sleeves);

    const [, emptyBox, thirdBox] = layout.panels[0].boxes;
    expect(emptyBox.sleeve.id).toBe('s2');
    expect(emptyBox.rows).toEqual([]);
    expect(emptyBox.height).toBeGreaterThan(0);
    // Sibling below the empty box must still start strictly after it, no overlap.
    expect(thirdBox.y).toBeGreaterThanOrEqual(emptyBox.y + emptyBox.height);
  });

  it('gives a zero-sleeve account a sensible height without breaking sibling panels', () => {
    const withSleeves1 = makeAccount('a1', 1);
    const empty = makeAccount('a2', 2);
    const withSleeves2 = makeAccount('a3', 3);
    const accounts = [withSleeves1, empty, withSleeves2];
    const sleeves = [
      makeSleeve('s1', 'a1', 5000, 1, [makeAsset('x1', 's1', 1, 100)]),
      makeSleeve('s2', 'a3', 5000, 2, [
        makeAsset('x2', 's2', 1, 100),
        makeAsset('x3', 's2', 2, 200),
      ]),
    ];

    const layout = layoutDiagram(accounts, sleeves);
    assertValidLayout(layout, accounts, sleeves);

    const [, emptyPanel, thirdPanel] = layout.panels;
    expect(emptyPanel.account.id).toBe('a2');
    expect(emptyPanel.boxes).toEqual([]);
    expect(emptyPanel.targetBps).toBe(0);
    expect(emptyPanel.holdingCents).toBe(0);
    // Panels sit side by side (not stacked), so the empty one doesn't affect the third's x.
    expect(thirdPanel.x).toBeGreaterThanOrEqual(emptyPanel.x + emptyPanel.width);
    // All panels — including the empty one — share the same computed height.
    expect(emptyPanel.height).toBe(layout.panels[0].height);
  });
});
