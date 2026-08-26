import { ChevronDownIcon, ChevronUpIcon, PencilIcon } from 'lucide-react';
import type { Asset, PortfolioState } from '@shared/types';
import { api } from '@/lib/api';
import { moveSortOrder } from '@/lib/editor';
import { formatBps, formatCents } from '@/lib/money';
import { AssetDialog } from '@/components/editor/AssetDialog';
import { DeleteEntityButton } from '@/components/editor/DeleteEntityButton';
import { Button } from '@/components/ui/button';

interface AssetRowProps {
  asset: Asset;
  /** This sleeve's assets, already ordered — for reorder computation. */
  siblingAssets: Asset[];
  onSaved: (portfolio: PortfolioState) => void;
}

export function AssetRow({ asset, siblingAssets, onSaved }: AssetRowProps) {
  const index = siblingAssets.findIndex((sibling) => sibling.id === asset.id);
  const isFirst = index <= 0;
  const isLast = index === -1 || index === siblingAssets.length - 1;

  const move = async (direction: 'up' | 'down') => {
    const pairs = moveSortOrder(siblingAssets, asset.id, direction);
    if (pairs.length === 0) return;
    try {
      // The second call's response is authoritative: it reflects both writes.
      await api.updateAsset(pairs[0].id, { sortOrder: pairs[0].sortOrder });
      onSaved(await api.updateAsset(pairs[1].id, { sortOrder: pairs[1].sortOrder }));
    } catch (caught) {
      // Rare (a 404 would mean the row was deleted concurrently) — no toast
      // system is wired up in this app yet, so a plain alert is enough here.
      console.error('Could not reorder asset', caught);
      window.alert('Could not reorder that asset. Please refresh and try again.');
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background px-2.5 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{asset.ticker}</span>
        {asset.label && <span className="text-xs text-muted-foreground">{asset.label}</span>}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatBps(asset.weightBps)} of sleeve
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatCents(asset.holdingCents)}
        </span>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${asset.ticker} up`}
            disabled={isFirst}
            onClick={() => void move('up')}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${asset.ticker} down`}
            disabled={isLast}
            onClick={() => void move('down')}
          >
            <ChevronDownIcon />
          </Button>
          <AssetDialog
            sleeveId={asset.sleeveId}
            asset={asset}
            onSaved={onSaved}
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${asset.ticker}`}>
                <PencilIcon />
              </Button>
            }
          />
          <DeleteEntityButton
            entityLabel={asset.ticker}
            onDelete={async () => onSaved(await api.deleteAsset(asset.id))}
          />
        </div>
      </div>
    </div>
  );
}
