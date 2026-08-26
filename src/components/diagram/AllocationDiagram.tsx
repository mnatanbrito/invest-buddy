import { useMemo } from 'react';
import type { AllocationLine, AllocationPlan, PortfolioState } from '@shared/types';
import { formatBps, formatCentsShort, formatDriftBps } from '@/lib/money';
import { layoutDiagram, type AssetRowGeometry, type BoxGeometry } from './layout';

export interface DiagramFlight {
  /** Bumped on every execution so React remounts the tokens and replays the animation. */
  key: number;
  plan: AllocationPlan;
}

interface AllocationDiagramProps {
  portfolio: PortfolioState;
  /** Live preview of where the typed amount would go. */
  preview: AllocationPlan | null;
  /** Set briefly after an investment executes, to animate the money in. */
  flight: DiagramFlight | null;
}

/** Naive greedy wrap; the notes are short and fixed, so this is all they need. */
function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current && `${current} ${word}`.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const accountListFormatter = new Intl.ListFormat('en-CA', { style: 'long', type: 'conjunction' });

/** Number of `.acct-color-N` slots defined in src/index.css; panel color cycles past this. */
const PALETTE_SIZE = 10;

/** Panels are colored by their INDEX (position in the accounts array), not by account id —
 *  account ids are random UUIDs once created through the editor, so there's no way to key a
 *  fixed CSS class off them the way the original 3-account preset's ids ('rrsp'/'tfsa'/
 *  'non_registered') allowed. */
function panelColorClass(index: number): string {
  return `acct-color-${index % PALETTE_SIZE}`;
}

export function AllocationDiagram({ portfolio, preview, flight }: AllocationDiagramProps) {
  const layout = useMemo(
    () => layoutDiagram(portfolio.accounts, portfolio.sleeves),
    [portfolio.accounts, portfolio.sleeves],
  );
  const { canvas, flowOrigin, panels } = layout;

  const previewByAsset = useMemo(
    () => new Map((preview?.lines ?? []).map((line) => [line.assetId, line])),
    [preview],
  );

  const rowsById = useMemo(() => {
    const map = new Map<string, AssetRowGeometry>();
    for (const panel of panels) {
      for (const box of panel.boxes) {
        for (const row of box.rows) map.set(row.asset.id, row);
      }
    }
    return map;
  }, [panels]);

  /** Account id -> its panel's index, so flow tokens (keyed by accountId) can be colored
   *  the same way panels are: by position, not by the account's (possibly random) id. */
  const panelIndexByAccountId = useMemo(() => {
    const map = new Map<string, number>();
    panels.forEach((panel, index) => map.set(panel.account.id, index));
    return map;
  }, [panels]);

  /** Only assets that actually received money get a token and a pulse. */
  const flownLines = (flight?.plan.lines ?? []).filter((line) => line.amountCents > 0);
  const flightDelay = new Map(flownLines.map((line, index) => [line.assetId, index * 0.07]));

  const accountLabels = portfolio.accounts.map((account) => account.label);
  const ariaLabel = accountLabels.length > 0
    ? `Target allocation across ${accountListFormatter.format(accountLabels)}`
    : 'Target allocation across your accounts';

  const wide = canvas.width > 1000;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${canvas.width} ${canvas.height}`}
        width={wide ? canvas.width : undefined}
        className={wide ? 'h-auto select-none' : 'w-full h-auto select-none'}
        role="img"
        aria-label={ariaLabel}
      >
        <title>Target allocation by account</title>

        <defs>
          {/* Marks boxes in an account whose contribution room is used up. */}
          <pattern id="room-exhausted-hatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="8" height="8" fill="transparent" />
            <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" strokeWidth="3" opacity="0.13" />
          </pattern>
        </defs>

        {panels.map((panel, panelIndex) => {
          const { account } = panel;
          const exhausted = account.roomRemainingCents === 0;
          const noteLines = wrap(account.note, 30);

          return (
            <g key={account.id} className={panelColorClass(panelIndex)}>
              <rect
                x={panel.x}
                y={panel.y}
                width={panel.width}
                height={panel.height}
                rx={20}
                fill="var(--panel-fill)"
                stroke="var(--panel-stroke)"
                strokeWidth={1.5}
              />

              <text
                x={panel.centerX}
                y={panel.y + 40}
                textAnchor="middle"
                fontSize={23}
                fontWeight={650}
                fill="var(--ink-strong)"
              >
                {account.label}
              </text>
              <text x={panel.centerX} y={panel.y + 64} textAnchor="middle" fontSize={14} fill="var(--ink)">
                {formatBps(panel.targetBps)} of portfolio
              </text>

              {/* Contribution room chip. Non-registered has no limit, so it shows nothing. */}
              {account.roomRemainingCents !== null && (
                <RoomChip
                  centerX={panel.centerX}
                  y={panel.y + 78}
                  remainingCents={account.roomRemainingCents}
                  exhausted={exhausted}
                />
              )}

              {panel.boxes.map((box) => (
                <SleeveBox
                  key={box.sleeve.id}
                  box={box}
                  exhausted={exhausted}
                  previewByAsset={previewByAsset}
                  flightDelay={flightDelay}
                />
              ))}

              <text
                x={panel.centerX}
                y={panel.y + panel.height - 92}
                textAnchor="middle"
                fontSize={13}
                fill="var(--ink)"
                fontWeight={600}
              >
                {formatCentsShort(panel.holdingCents)} held
              </text>

              {noteLines.map((line, index) => (
                <text
                  key={line}
                  x={panel.centerX}
                  y={panel.y + panel.height - 48 + index * 19}
                  textAnchor="middle"
                  fontSize={13.5}
                  fill="var(--diagram-note)"
                >
                  {line}
                </text>
              ))}
            </g>
          );
        })}

        {/* Money in flight: one token per funded asset, launched from under the input. */}
        {flight && (
          <g key={flight.key}>
            {flownLines.map((line) => {
              const row = rowsById.get(line.assetId);
              if (!row) return null;
              const panelIndex = panelIndexByAccountId.get(line.accountId) ?? 0;
              return (
                <g
                  key={line.assetId}
                  transform={`translate(${flowOrigin.x}, ${flowOrigin.y})`}
                  className={panelColorClass(panelIndex)}
                >
                  <g
                    className="flow-token"
                    style={
                      {
                        '--dx': `${row.centerX - flowOrigin.x}px`,
                        '--dy': `${row.centerY - flowOrigin.y}px`,
                        '--delay': `${flightDelay.get(line.assetId) ?? 0}s`,
                      } as React.CSSProperties
                    }
                  >
                    <rect x={-46} y={-14} width={92} height={28} rx={14} fill="var(--box-stroke)" />
                    <text
                      x={0}
                      y={5}
                      textAnchor="middle"
                      fontSize={14}
                      fontWeight={650}
                      fill="#ffffff"
                    >
                      {formatCentsShort(line.amountCents)}
                    </text>
                  </g>
                </g>
              );
            })}
          </g>
        )}
      </svg>
    </div>
  );
}

function RoomChip({
  centerX,
  y,
  remainingCents,
  exhausted,
}: {
  centerX: number;
  y: number;
  remainingCents: number;
  exhausted: boolean;
}) {
  const label = exhausted ? 'No room left' : `${formatCentsShort(remainingCents)} room left`;
  const width = Math.max(122, label.length * 7.1 + 30);

  return (
    <g>
      <rect
        x={centerX - width / 2}
        y={y}
        width={width}
        height={24}
        rx={12}
        fill={exhausted ? 'var(--destructive)' : 'transparent'}
        fillOpacity={exhausted ? 0.12 : 1}
        stroke={exhausted ? 'var(--destructive)' : 'var(--panel-stroke)'}
        strokeWidth={1.2}
      />
      {exhausted && (
        <g transform={`translate(${centerX - width / 2 + 13}, ${y + 6})`} stroke="var(--destructive)" strokeWidth={1.6} fill="none">
          <rect x={0} y={5} width={11} height={7.5} rx={1.6} />
          <path d="M2.2 5V3.4a3.3 3.3 0 0 1 6.6 0V5" />
        </g>
      )}
      <text
        x={exhausted ? centerX + 7 : centerX}
        y={y + 16.5}
        textAnchor="middle"
        fontSize={12}
        fontWeight={600}
        fill={exhausted ? 'var(--destructive)' : 'var(--ink)'}
      >
        {label}
      </text>
    </g>
  );
}

function SleeveBox({
  box,
  exhausted,
  previewByAsset,
  flightDelay,
}: {
  box: BoxGeometry;
  exhausted: boolean;
  previewByAsset: Map<string, AllocationLine>;
  flightDelay: Map<string, number>;
}) {
  const { sleeve, x, y, width, height } = box;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={14}
        fill="transparent"
        stroke="var(--box-stroke)"
        strokeWidth={1.5}
      />

      {exhausted && (
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          rx={14}
          fill="url(#room-exhausted-hatch)"
          color="var(--destructive)"
          pointerEvents="none"
        />
      )}

      {/* Box header: sleeve label and its share of the whole portfolio. Per-asset detail lives in the rows below. */}
      <text x={box.centerX} y={y + 32} textAnchor="middle" fontSize={17} fontWeight={650} fill="var(--ink-strong)">
        {sleeve.label}
      </text>
      <text x={box.centerX} y={y + 54} textAnchor="middle" fontSize={13} fill="var(--ink)">
        {formatBps(sleeve.targetBps)} of portfolio
      </text>

      <line
        x1={x + 18}
        y1={y + 74}
        x2={x + width - 18}
        y2={y + 74}
        stroke="var(--panel-stroke)"
        strokeWidth={1}
      />

      {box.rows.length === 0 && (
        <text x={box.centerX} y={y + height - 10} textAnchor="middle" fontSize={12.5} fill="var(--diagram-note)">
          No assets yet
        </text>
      )}

      {box.rows.map((row, index) => (
        <AssetRow
          key={row.asset.id}
          row={row}
          isFirst={index === 0}
          previewCents={previewByAsset.get(row.asset.id)?.amountCents ?? 0}
          previewBlockedCents={previewByAsset.get(row.asset.id)?.blockedCents ?? 0}
          receiving={flightDelay.has(row.asset.id)}
          delay={flightDelay.get(row.asset.id) ?? 0}
        />
      ))}
    </g>
  );
}

function AssetRow({
  row,
  isFirst,
  previewCents,
  previewBlockedCents,
  receiving,
  delay,
}: {
  row: AssetRowGeometry;
  isFirst: boolean;
  previewCents: number;
  previewBlockedCents: number;
  receiving: boolean;
  delay: number;
}) {
  const { asset, x, y, width, height } = row;
  const delayStyle = { '--delay': `${delay}s` } as React.CSSProperties;

  // Rows have no built-in horizontal inset (row.x/row.width span the box's full
  // inner width), so content is inset here, mirroring the box's own 18px inset.
  const insetX = x + 18;
  const endX = x + width - 18;

  // Drift bar: the track is the target weight, the fill is the actual weight,
  // computed from THIS asset's own actual/effective-target (not the sleeve's).
  const barWidth = width - 36;
  const driftRatio = asset.effectiveTargetBps > 0
    ? Math.min(2, asset.actualBps / asset.effectiveTargetBps)
    : 0;

  return (
    <g>
      {/* Divider between rows within the same box; the box header already has its own line above the first row. */}
      {!isFirst && (
        <line x1={insetX} y1={y} x2={endX} y2={y} stroke="var(--panel-stroke)" strokeWidth={1} />
      )}

      {receiving && (
        <rect
          className="box-glow"
          x={x + 2}
          y={y + 3}
          width={width - 4}
          height={height - 6}
          rx={10}
          fill="var(--box-stroke)"
          style={delayStyle}
        />
      )}
      {receiving && (
        <rect
          x={x + 2}
          y={y + 3}
          width={width - 4}
          height={height - 6}
          rx={10}
          fill="transparent"
          stroke="var(--box-stroke)"
          strokeWidth={1.2}
          className="box-receiving"
          style={delayStyle}
        />
      )}

      <text x={insetX} y={y + 20} fontSize={14.5} fontWeight={600} fill="var(--ink-strong)">
        {asset.ticker}
      </text>

      {/* While a deposit is being previewed for this asset, its incoming amount
          replaces the static "share of sleeve" readout so the two never fight for space. */}
      {previewCents > 0 ? (
        <g className="preview-amount">
          <text x={endX} y={y + 20} textAnchor="end" fontSize={13} fontWeight={650} fill="var(--box-stroke)">
            {`+${formatCentsShort(previewCents)}`}
          </text>
        </g>
      ) : (
        <text x={endX} y={y + 20} textAnchor="end" fontSize={11.5} fill="var(--diagram-meta)">
          {formatBps(asset.weightBps)} of sleeve
        </text>
      )}

      <text x={insetX} y={y + 37} fontSize={12} fontWeight={600} fill="var(--ink)">
        {formatCentsShort(asset.holdingCents)}
      </text>
      <text x={endX} y={y + 37} textAnchor="end" fontSize={11} fill="var(--diagram-meta)">
        {asset.holdingCents > 0 ? `${formatBps(asset.actualBps)} · ${formatDriftBps(asset.driftBps)}` : 'empty'}
      </text>

      <rect x={insetX} y={y + 43} width={barWidth} height={5} rx={2.5} fill="var(--diagram-track)" />
      <rect
        x={insetX}
        y={y + 43}
        width={Math.min(barWidth, (barWidth / 2) * driftRatio)}
        height={5}
        rx={2.5}
        fill="var(--box-stroke)"
      />
      {/* Tick at the halfway point of the track, which is where "on target" sits. */}
      <line
        x1={insetX + barWidth / 2}
        y1={y + 41}
        x2={insetX + barWidth / 2}
        y2={y + 50}
        stroke="var(--ink-strong)"
        strokeWidth={1.3}
      />

      {previewBlockedCents > 0 && (
        <g className="preview-amount">
          <text
            x={row.centerX}
            y={y + height - 3}
            textAnchor="middle"
            fontSize={10}
            fontWeight={600}
            fill="var(--destructive)"
          >
            {formatCentsShort(previewBlockedCents)} blocked
          </text>
        </g>
      )}
    </g>
  );
}
