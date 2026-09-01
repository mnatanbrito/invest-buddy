import type { InvestmentRecord, PortfolioState } from '@shared/types';
import { formatCents } from '@/lib/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Assets</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((record) => (
              <TableRow key={record.id}>
                <TableCell className="text-sm">
                  {record.label || <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(record.createdAt).toLocaleString('en-CA', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </TableCell>
                <TableCell className="font-medium tabular-nums">
                  {formatCents(record.requestedCents)}
                </TableCell>
                <TableCell className="whitespace-normal">
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
                    <p className="mt-1.5 text-xs text-destructive">
                      {formatCents(record.unallocatedCents)} held back as cash — contribution room ran
                      out.
                    </p>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
