import type { InvestmentRecord, PortfolioState } from '@shared/types';
import { formatCents } from '@/lib/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface HistoryPanelProps {
  history: InvestmentRecord[];
  portfolio: PortfolioState;
  onUndo: () => void;
  undoing: boolean;
}

export function HistoryPanel({ history, portfolio, onUndo, undoing }: HistoryPanelProps) {
  const assetTickers = new Map(
    portfolio.sleeves.flatMap((sleeve) => sleeve.assets.map((asset) => [asset.id, asset.ticker])),
  );

  if (history.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No investments recorded yet. Enter an amount above to make the first one.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Recent investments</h2>
        <Button variant="ghost" size="sm" onClick={onUndo} disabled={undoing}>
          {undoing ? 'Undoing…' : 'Undo last'}
        </Button>
      </div>

      <ul className="divide-y rounded-lg border">
        {history.map((record) => (
          <li key={record.id} className="p-3 space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-medium tabular-nums">{formatCents(record.requestedCents)}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(record.createdAt).toLocaleString('en-CA', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </span>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {record.lines
                .filter((line) => line.amountCents > 0)
                .map((line) => (
                  <Badge key={line.assetId} variant="secondary" className="font-normal tabular-nums">
                    {assetTickers.get(line.assetId) ?? line.assetId} {formatCents(line.amountCents)}
                  </Badge>
                ))}
            </div>

            {record.unallocatedCents > 0 && (
              <p className="text-xs text-destructive">
                {formatCents(record.unallocatedCents)} held back as cash — contribution room ran out.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
