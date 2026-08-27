import { useState } from 'react';
import type { Asset, PortfolioState } from '@shared/types';
import { api } from '@/lib/api';
import { moveSortOrder } from '@/lib/editor';
import { formatBps, formatCents } from '@/lib/money';
import { AssetDialog } from '@/components/editor/AssetDialog';
import { DeleteEntityDialog } from '@/components/editor/DeleteEntityDialog';
import { EntityActionsMenu } from '@/components/editor/EntityActionsMenu';

interface AssetRowProps {
  asset: Asset;
  /** This sleeve's assets, already ordered — for reorder computation. */
  siblingAssets: Asset[];
  onSaved: (portfolio: PortfolioState) => void;
}

export function AssetRow({ asset, siblingAssets, onSaved }: AssetRowProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

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

        <div>
          <EntityActionsMenu
            entityLabel={asset.ticker}
            isFirst={isFirst}
            isLast={isLast}
            onMoveUp={() => void move('up')}
            onMoveDown={() => void move('down')}
            onEdit={() => setEditOpen(true)}
            onDelete={() => setDeleteOpen(true)}
          />
          <AssetDialog
            sleeveId={asset.sleeveId}
            asset={asset}
            onSaved={onSaved}
            open={editOpen}
            onOpenChange={setEditOpen}
          />
          <DeleteEntityDialog
            entityLabel={asset.ticker}
            onDelete={async () => onSaved(await api.deleteAsset(asset.id))}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
          />
        </div>
      </div>
    </div>
  );
}
