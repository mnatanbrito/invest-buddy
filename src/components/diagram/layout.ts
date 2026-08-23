import type { Account, Sleeve } from '@shared/types';

/**
 * Geometry for the allocation diagram, laid out to mirror the source image:
 * three account panels side by side, each holding its sleeves as inner boxes.
 * Everything is computed in one place so the SVG, the flow tokens and the
 * hit targets can never drift out of alignment.
 */
export const CANVAS = { width: 1000, height: 660 } as const;

const PANEL = { top: 8, width: 304, height: 588, gap: 28, marginX: 16 } as const;
const BOX = { insetX: 24, top: 128, height: 164, gap: 14 } as const;

/** Where the flow tokens are born: bottom centre, under the panels, near the input. */
export const FLOW_ORIGIN = { x: CANVAS.width / 2, y: CANVAS.height - 8 } as const;

export interface BoxGeometry {
  sleeve: Sleeve;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface PanelGeometry {
  account: Account;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  boxes: BoxGeometry[];
  /** Share of the whole portfolio this account targets, in basis points. */
  targetBps: number;
}

export function layoutDiagram(accounts: Account[], sleeves: Sleeve[]): PanelGeometry[] {
  return accounts.map((account, index) => {
    const x = PANEL.marginX + index * (PANEL.width + PANEL.gap);
    const own = sleeves
      .filter((sleeve) => sleeve.accountId === account.id)
      .sort((a, b) => a.sortOrder - b.sortOrder);

    const boxWidth = PANEL.width - BOX.insetX * 2;

    return {
      account,
      x,
      y: PANEL.top,
      width: PANEL.width,
      height: PANEL.height,
      centerX: x + PANEL.width / 2,
      targetBps: own.reduce((sum, sleeve) => sum + sleeve.targetBps, 0),
      boxes: own.map((sleeve, boxIndex) => {
        const boxY = PANEL.top + BOX.top + boxIndex * (BOX.height + BOX.gap);
        return {
          sleeve,
          x: x + BOX.insetX,
          y: boxY,
          width: boxWidth,
          height: BOX.height,
          centerX: x + PANEL.width / 2,
          centerY: boxY + BOX.height / 2,
        };
      }),
    };
  });
}
