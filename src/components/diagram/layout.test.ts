import { describe, expect, it } from 'vitest';
import type { Account, Sleeve } from '@shared/types';
import { CANVAS, FLOW_ORIGIN, layoutDiagram } from './layout';

const accounts: Account[] = [
  { id: 'rrsp', label: 'RRSP', note: 'US-listed direct, no withholding tax', roomLimitCents: 5_000_000, roomUsedCents: 0, roomRemainingCents: 5_000_000, sortOrder: 1 },
  { id: 'tfsa', label: 'TFSA', note: 'Highest-growth assets, tax-free forever', roomLimitCents: 2_500_000, roomUsedCents: 0, roomRemainingCents: 2_500_000, sortOrder: 2 },
  { id: 'non_registered', label: 'Non-registered', note: 'Overflow once RRSP and TFSA are maxed', roomLimitCents: null, roomUsedCents: 0, roomRemainingCents: null, sortOrder: 3 },
];

const sleeve = (id: string, accountId: string, targetBps: number, sortOrder: number): Sleeve => ({
  id,
  accountId,
  tickers: id,
  label: id,
  targetBps,
  holdingCents: 0,
  actualBps: 0,
  driftBps: 0,
  sortOrder,
});

const sleeves: Sleeve[] = [
  sleeve('us_equity', 'rrsp', 4500, 1),
  sleeve('cad_bonds', 'rrsp', 1000, 2),
  sleeve('cad_equity', 'tfsa', 2000, 3),
  sleeve('intl_equity', 'tfsa', 1500, 4),
  sleeve('em_equity', 'non_registered', 1000, 5),
];

const panels = () => layoutDiagram(accounts, sleeves);

describe('layoutDiagram', () => {
  it('lays out one panel per account, in order', () => {
    const result = panels();
    expect(result.map((panel) => panel.account.id)).toEqual(['rrsp', 'tfsa', 'non_registered']);
    expect(result.map((panel) => panel.x)).toEqual([...result.map((p) => p.x)].sort((a, b) => a - b));
  });

  it('keeps panels inside the canvas and clear of each other', () => {
    for (const panel of panels()) {
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(CANVAS.width);
    }

    const ordered = panels();
    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1];
      expect(ordered[i].x).toBeGreaterThanOrEqual(previous.x + previous.width);
    }
  });

  it('contains every box fully within its panel', () => {
    // The bottom edge is the constraint that broke once: growing BOX.height pushed
    // content past the panel and onto the drift bar below it.
    for (const panel of panels()) {
      for (const box of panel.boxes) {
        expect(box.x).toBeGreaterThanOrEqual(panel.x);
        expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width);
        expect(box.y).toBeGreaterThanOrEqual(panel.y);
        expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height);
      }
    }
  });

  it('never overlaps two boxes in the same panel', () => {
    for (const panel of panels()) {
      for (let i = 1; i < panel.boxes.length; i++) {
        const previous = panel.boxes[i - 1];
        expect(panel.boxes[i].y).toBeGreaterThanOrEqual(previous.y + previous.height);
      }
    }
  });

  it('gives each account exactly its own sleeves, in sort order', () => {
    const [rrsp, tfsa, nonRegistered] = panels();
    expect(rrsp.boxes.map((box) => box.sleeve.id)).toEqual(['us_equity', 'cad_bonds']);
    expect(tfsa.boxes.map((box) => box.sleeve.id)).toEqual(['cad_equity', 'intl_equity']);
    expect(nonRegistered.boxes.map((box) => box.sleeve.id)).toEqual(['em_equity']);
  });

  it('sums each panel target from its sleeves, totalling the whole portfolio', () => {
    const result = panels();
    expect(result.map((panel) => panel.targetBps)).toEqual([5500, 3500, 1000]);
    expect(result.reduce((sum, panel) => sum + panel.targetBps, 0)).toBe(10_000);
  });

  it('centres every box on its panel, so flow tokens land on the middle', () => {
    for (const panel of panels()) {
      for (const box of panel.boxes) {
        expect(box.centerX).toBe(panel.centerX);
        expect(box.centerY).toBe(box.y + box.height / 2);
      }
    }
  });

  it('puts the flow origin below every box, so tokens travel upward', () => {
    for (const panel of panels()) {
      for (const box of panel.boxes) {
        expect(FLOW_ORIGIN.y).toBeGreaterThan(box.centerY);
      }
    }
    expect(FLOW_ORIGIN.y).toBeLessThanOrEqual(CANVAS.height);
    expect(FLOW_ORIGIN.x).toBe(CANVAS.width / 2);
  });

  it('handles an account with no sleeves without breaking the row', () => {
    const result = layoutDiagram(accounts, sleeves.filter((s) => s.accountId !== 'tfsa'));
    expect(result[1].boxes).toEqual([]);
    expect(result[1].targetBps).toBe(0);
    expect(result[2].boxes).toHaveLength(1);
  });
});
