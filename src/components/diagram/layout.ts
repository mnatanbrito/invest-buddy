import type { Account, Asset, Sleeve } from '@shared/types';

/**
 * Geometry for the allocation diagram: one panel per account, each holding its
 * sleeves as inner boxes, each box holding its assets as inner rows. Because the
 * portfolio is fully user-editable, none of this can be a fixed canvas anymore —
 * every dimension is derived from how much content actually needs to fit, then
 * the tallest panel's content height is applied to every panel so they still
 * visually align. Everything is computed in one place so the SVG, the flow
 * tokens and the hit targets can never drift out of alignment.
 */

/** Height of one asset row: ticker, weight%, and a holding/drift summary. */
const ROW_HEIGHT = 60;
/** Height of a sleeve box's header: label, target%, and the divider above its rows. */
const BOX_HEADER_HEIGHT = 96;
/** Breathing room below a box's last row. */
const BOX_PAD_BOTTOM = 12;
/** Height of a panel's header: account label, target%, room chip. */
const PANEL_HEADER_HEIGHT = 120;
/** Room below a panel's last box for the "$X held" total and the wrapped note. */
const PANEL_PAD_BOTTOM = 110;
/** Vertical gap between stacked sleeve boxes within a panel. */
const BOX_GAP = 14;
/** Horizontal inset of a box within its panel (also the box's own horizontal padding). */
const BOX_INSET_X = 24;
/** Fixed width of every panel, regardless of content. */
const PANEL_WIDTH = 304;
/** Horizontal gap between panels. */
const PANEL_GAP = 28;
/** Left/right margin of the whole canvas. */
const MARGIN_X = 16;
/** Fixed y of every panel's top edge. */
const PANEL_TOP = 8;
/** Extra room below the tallest panel for the flow-origin token launch point. */
const FLOW_ORIGIN_CLEARANCE = 70;
/** Canvas never renders narrower than this, so a single account isn't a sliver. */
const MIN_CANVAS_WIDTH = 1000;

export interface AssetRowGeometry {
  asset: Asset;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface BoxGeometry {
  sleeve: Sleeve;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  /** One per sleeve.assets, in order. */
  rows: AssetRowGeometry[];
}

export interface PanelGeometry {
  account: Account;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  /** One per this account's sleeves, in order. */
  boxes: BoxGeometry[];
  /** Share of the whole portfolio this account targets, in basis points. */
  targetBps: number;
  /** Sum of this account's sleeves' holdings, in cents. */
  holdingCents: number;
}

export interface DiagramLayout {
  canvas: { width: number; height: number };
  /** Where the flow tokens are born: bottom centre, under the panels, near the input. */
  flowOrigin: { x: number; y: number };
  panels: PanelGeometry[];
}

/** A box's height grows with how many assets its sleeve holds. */
function boxHeight(sleeve: Sleeve): number {
  return BOX_HEADER_HEIGHT + sleeve.assets.length * ROW_HEIGHT + BOX_PAD_BOTTOM;
}

/** A panel's content height grows with how many sleeves its account holds, and how tall each is. */
function panelContentHeight(sleevesForAccount: Sleeve[]): number {
  if (sleevesForAccount.length === 0) {
    return PANEL_HEADER_HEIGHT + PANEL_PAD_BOTTOM;
  }
  const boxesHeight = sleevesForAccount.reduce((sum, sleeve) => sum + boxHeight(sleeve) + BOX_GAP, 0) - BOX_GAP;
  return PANEL_HEADER_HEIGHT + boxesHeight + PANEL_PAD_BOTTOM;
}

export function layoutDiagram(accounts: Account[], sleeves: Sleeve[]): DiagramLayout {
  const sleevesByAccount = accounts.map((account) => sleeves.filter((sleeve) => sleeve.accountId === account.id));

  const panelHeight = accounts.length === 0
    ? PANEL_HEADER_HEIGHT + PANEL_PAD_BOTTOM
    : Math.max(...sleevesByAccount.map((own) => panelContentHeight(own)));

  const panelCount = accounts.length;
  const canvasWidth = Math.max(
    MIN_CANVAS_WIDTH,
    MARGIN_X * 2 + panelCount * PANEL_WIDTH + Math.max(0, panelCount - 1) * PANEL_GAP,
  );
  const canvasHeight = PANEL_TOP * 2 + panelHeight + FLOW_ORIGIN_CLEARANCE;

  const boxWidth = PANEL_WIDTH - BOX_INSET_X * 2;

  const panels: PanelGeometry[] = accounts.map((account, index) => {
    const own = sleevesByAccount[index];
    const x = MARGIN_X + index * (PANEL_WIDTH + PANEL_GAP);
    const centerX = x + PANEL_WIDTH / 2;

    let boxY = PANEL_TOP + PANEL_HEADER_HEIGHT;
    const boxes: BoxGeometry[] = own.map((sleeve) => {
      const height = boxHeight(sleeve);
      const boxX = x + BOX_INSET_X;
      const boxCenterX = centerX;
      const boxCenterY = boxY + height / 2;

      let rowY = boxY + BOX_HEADER_HEIGHT;
      const rows: AssetRowGeometry[] = sleeve.assets.map((asset) => {
        const row: AssetRowGeometry = {
          asset,
          x: boxX,
          y: rowY,
          width: boxWidth,
          height: ROW_HEIGHT,
          centerX: boxCenterX,
          centerY: rowY + ROW_HEIGHT / 2,
        };
        rowY += ROW_HEIGHT;
        return row;
      });

      const box: BoxGeometry = {
        sleeve,
        x: boxX,
        y: boxY,
        width: boxWidth,
        height,
        centerX: boxCenterX,
        centerY: boxCenterY,
        rows,
      };
      boxY += height + BOX_GAP;
      return box;
    });

    return {
      account,
      x,
      y: PANEL_TOP,
      width: PANEL_WIDTH,
      height: panelHeight,
      centerX,
      boxes,
      targetBps: own.reduce((sum, sleeve) => sum + sleeve.targetBps, 0),
      holdingCents: own.reduce((sum, sleeve) => sum + sleeve.holdingCents, 0),
    };
  });

  return {
    canvas: { width: canvasWidth, height: canvasHeight },
    flowOrigin: { x: canvasWidth / 2, y: canvasHeight - 8 },
    panels,
  };
}
