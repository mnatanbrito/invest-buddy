import { ChevronDownIcon, ChevronUpIcon, PencilIcon } from 'lucide-react';
import type { PortfolioState, Sleeve } from '@shared/types';
import { MAX_ASSETS_PER_SLEEVE } from '@shared/allocation';
import { api } from '@/lib/api';
import { moveSortOrder } from '@/lib/editor';
import { formatBps } from '@/lib/money';
import { cn } from '@/lib/utils';
import { AssetDialog } from '@/components/editor/AssetDialog';
import { AssetRow } from '@/components/editor/AssetRow';
import { DeleteEntityButton } from '@/components/editor/DeleteEntityButton';
import { SleeveDialog } from '@/components/editor/SleeveDialog';
import { Button } from '@/components/ui/button';

interface SleeveRowProps {
  sleeve: Sleeve;
  /** This account's sleeves, already ordered — for reorder computation. */
  siblingSleeves: Sleeve[];
  onSaved: (portfolio: PortfolioState) => void;
}

export function SleeveRow({ sleeve, siblingSleeves, onSaved }: SleeveRowProps) {
  const index = siblingSleeves.findIndex((sibling) => sibling.id === sleeve.id);
  const isFirst = index <= 0;
  const isLast = index === -1 || index === siblingSleeves.length - 1;

  const move = async (direction: 'up' | 'down') => {
    const pairs = moveSortOrder(siblingSleeves, sleeve.id, direction);
    if (pairs.length === 0) return;
    try {
      // The second call's response is authoritative: it reflects both writes.
      await api.updateSleeve(pairs[0].id, { sortOrder: pairs[0].sortOrder });
      onSaved(await api.updateSleeve(pairs[1].id, { sortOrder: pairs[1].sortOrder }));
    } catch (caught) {
      // Rare (a 404 would mean the row was deleted concurrently) — no toast
      // system is wired up in this app yet, so a plain alert is enough here.
      console.error('Could not reorder sleeve', caught);
      window.alert('Could not reorder that sleeve. Please refresh and try again.');
    }
  };

  const assetsMaxed = sleeve.assets.length >= MAX_ASSETS_PER_SLEEVE;
  const weightOk = sleeve.assetWeightTotalBps === 10_000;

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{sleeve.label}</p>
          <p className="text-xs text-muted-foreground">
            {formatBps(sleeve.targetBps)} share of whole portfolio · assets{' '}
            <span className={cn('tabular-nums', !weightOk && 'text-destructive')}>
              {formatBps(sleeve.assetWeightTotalBps)}
            </span>
          </p>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${sleeve.label} up`}
            disabled={isFirst}
            onClick={() => void move('up')}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${sleeve.label} down`}
            disabled={isLast}
            onClick={() => void move('down')}
          >
            <ChevronDownIcon />
          </Button>
          <SleeveDialog
            accountId={sleeve.accountId}
            sleeve={sleeve}
            onSaved={onSaved}
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${sleeve.label}`}>
                <PencilIcon />
              </Button>
            }
          />
          <DeleteEntityButton
            entityLabel={sleeve.label}
            onDelete={async () => onSaved(await api.deleteSleeve(sleeve.id))}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">Assets</h4>
        <AssetDialog
          sleeveId={sleeve.id}
          onSaved={onSaved}
          trigger={
            <Button
              variant="outline"
              size="sm"
              disabled={assetsMaxed}
              title={assetsMaxed ? `This sleeve already has ${MAX_ASSETS_PER_SLEEVE} assets` : undefined}
            >
              Add asset
            </Button>
          }
        />
      </div>

      {sleeve.assets.length === 0 ? (
        <p className="text-sm text-muted-foreground">No assets yet.</p>
      ) : (
        <div className="space-y-1">
          {sleeve.assets.map((asset) => (
            <AssetRow key={asset.id} asset={asset} siblingAssets={sleeve.assets} onSaved={onSaved} />
          ))}
        </div>
      )}
    </div>
  );
}
