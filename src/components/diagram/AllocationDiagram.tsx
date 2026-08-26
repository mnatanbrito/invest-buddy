import { useMemo } from 'react';
import type { AllocationPlan, PortfolioState } from '@shared/types';
import { formatBps, formatCentsShort, formatDriftBps } from '@/lib/money';
import { layoutDiagram, type BoxGeometry } from './layout';

// NOTE: this component still renders the OLD one-line-per-sleeve geometry (a
// single ticker line, no AssetRowGeometry rows). This is a deliberate
// placeholder patch (Task 12) to keep the build green after layout.ts's
// shape changed to DiagramLayout/canvas/flowOrigin/panel.holdingCents/
// AssetRowGeometry — it is NOT the real Stage-6 rendering rewrite. Task 13
// replaces this file's rendering logic to consume per-asset rows properly.

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

export function AllocationDiagram({ portfolio, preview, flight }: AllocationDiagramProps) {
  const layout = useMemo(
    () => layoutDiagram(portfolio.accounts, portfolio.sleeves),
    [portfolio.accounts, portfolio.sleeves],
  );
  const { canvas, flowOrigin, panels } = layout;

  const previewBySleeve = useMemo(
    () => new Map((preview?.lines ?? []).map((line) => [line.sleeveId, line])),
    [preview],
  );

  const boxesById = useMemo(() => {
    const map = new Map<string, BoxGeometry>();
    for (const panel of panels) for (const box of panel.boxes) map.set(box.sleeve.id, box);
    return map;
  }, [panels]);

  /** Only sleeves that actually received money get a token and a pulse. */
  const flownLines = (flight?.plan.lines ?? []).filter((line) => line.amountCents > 0);
  const flightDelay = new Map(flownLines.map((line, index) => [line.sleeveId, index * 0.07]));

  return (
    <svg
      viewBox={`0 0 ${canvas.width} ${canvas.height}`}
      className="w-full h-auto select-none"
      role="img"
      aria-label="Target allocation across RRSP, TFSA and non-registered accounts"
    >
      <title>Target allocation by account</title>

      <defs>
        {/* Marks boxes in an account whose contribution room is used up. */}
        <pattern id="room-exhausted-hatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" fill="transparent" />
          <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" strokeWidth="3" opacity="0.13" />
        </pattern>
      </defs>

      {panels.map((panel) => {
        const { account } = panel;
        const exhausted = account.roomRemainingCents === 0;
        const accountHoldings = panel.boxes.reduce((sum, box) => sum + box.sleeve.holdingCents, 0);
        const noteLines = wrap(account.note, 30);

        return (
          <g key={account.id} className={`acct-${account.id}`}>
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
                previewCents={previewBySleeve.get(box.sleeve.id)?.amountCents ?? 0}
                previewBlockedCents={previewBySleeve.get(box.sleeve.id)?.blockedCents ?? 0}
                receiving={flightDelay.has(box.sleeve.id)}
                delay={flightDelay.get(box.sleeve.id) ?? 0}
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
              {formatCentsShort(accountHoldings)} held
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

      {/* Money in flight: one token per funded sleeve, launched from under the input. */}
      {flight && (
        <g key={flight.key}>
          {flownLines.map((line) => {
            const box = boxesById.get(line.sleeveId);
            if (!box) return null;
            return (
              <g
                key={line.sleeveId}
                transform={`translate(${flowOrigin.x}, ${flowOrigin.y})`}
                className={`acct-${line.accountId}`}
              >
                <g
                  className="flow-token"
                  style={
                    {
                      '--dx': `${box.centerX - flowOrigin.x}px`,
                      '--dy': `${box.centerY - flowOrigin.y}px`,
                      '--delay': `${flightDelay.get(line.sleeveId) ?? 0}s`,
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
  previewCents,
  previewBlockedCents,
  receiving,
  delay,
}: {
  box: BoxGeometry;
  exhausted: boolean;
  previewCents: number;
  previewBlockedCents: number;
  receiving: boolean;
  delay: number;
}) {
  const { sleeve, x, y, width, height } = box;
  const delayStyle = { '--delay': `${delay}s` } as React.CSSProperties;

  // Drift bar: the track is the target weight, the fill is the actual weight,
  // so a short fill reads as underweight and an overfull one as overweight.
  const barWidth = width - 36;
  const driftRatio = sleeve.targetBps > 0 ? Math.min(2, sleeve.actualBps / sleeve.targetBps) : 0;

  const previewPillLabel = `+${formatCentsShort(previewCents)}`;
  const previewPillWidth = Math.max(88, previewPillLabel.length * 8.4 + 22);

  return (
    <g>
      {receiving && (
        <rect
          className="box-glow"
          x={x}
          y={y}
          width={width}
          height={height}
          rx={14}
          fill="var(--box-stroke)"
          style={delayStyle}
        />
      )}

      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={14}
        fill="transparent"
        stroke="var(--box-stroke)"
        strokeWidth={1.5}
        className={receiving ? 'box-receiving' : undefined}
        style={receiving ? delayStyle : undefined}
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

      <text x={box.centerX} y={y + 30} textAnchor="middle" fontSize={16.5} fontWeight={600} fill="var(--ink)">
        {sleeve.assets.map((asset) => asset.ticker).join(' / ') || 'No assets yet'}
      </text>
      <text x={box.centerX} y={y + 51} textAnchor="middle" fontSize={13.5} fill="var(--ink)">
        {sleeve.label}
      </text>
      <text x={box.centerX} y={y + 84} textAnchor="middle" fontSize={25} fontWeight={700} fill="var(--ink-strong)">
        {formatBps(sleeve.targetBps)}
      </text>

      <line
        x1={x + 18}
        y1={y + 99}
        x2={x + width - 18}
        y2={y + 99}
        stroke="var(--panel-stroke)"
        strokeWidth={1}
      />

      <text x={x + 18} y={y + 121} fontSize={13} fontWeight={600} fill="var(--ink-strong)">
        {formatCentsShort(sleeve.holdingCents)}
      </text>
      <text x={x + width - 18} y={y + 121} textAnchor="end" fontSize={12} fill="var(--diagram-meta)">
        {sleeve.holdingCents > 0 ? `${formatBps(sleeve.actualBps)} · ${formatDriftBps(sleeve.driftBps)}` : 'empty'}
      </text>

      <rect x={x + 18} y={y + 130} width={barWidth} height={6} rx={3} fill="var(--diagram-track)" />
      <rect
        x={x + 18}
        y={y + 130}
        width={Math.min(barWidth, (barWidth / 2) * driftRatio)}
        height={6}
        rx={3}
        fill="var(--box-stroke)"
      />
      {/* Tick at the halfway point of the track, which is where "on target" sits. */}
      <line
        x1={x + 18 + barWidth / 2}
        y1={y + 127}
        x2={x + 18 + barWidth / 2}
        y2={y + 139}
        stroke="var(--ink-strong)"
        strokeWidth={1.5}
      />

      {/* Incoming amount, straddling the top edge of the box. */}
      {previewCents > 0 && (
        <g className="preview-amount">
          <rect
            x={box.centerX - previewPillWidth / 2}
            y={y - 14}
            width={previewPillWidth}
            height={28}
            rx={14}
            fill="var(--box-stroke)"
          />
          <text x={box.centerX} y={y + 5} textAnchor="middle" fontSize={14} fontWeight={650} fill="#ffffff">
            {previewPillLabel}
          </text>
        </g>
      )}

      {previewBlockedCents > 0 && (
        <g className="preview-amount">
          <text
            x={box.centerX}
            y={y + height - 8}
            textAnchor="middle"
            fontSize={12}
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
