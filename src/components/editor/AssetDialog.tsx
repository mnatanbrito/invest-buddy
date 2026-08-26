import { useState, type ReactNode } from 'react';
import type { Asset, PortfolioState } from '@shared/types';
import { api } from '@/lib/api';
import { bpsFromPercentField, percentFieldFromBps } from '@/lib/editor';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface AssetDialogProps {
  /** The parent sleeve this asset belongs to (or will belong to on create). */
  sleeveId: string;
  /** undefined = create mode, present = edit mode. */
  asset?: Asset;
  onSaved: (portfolio: PortfolioState) => void;
  /** The element that opens the dialog (a Button, typically), used with DialogTrigger asChild. */
  trigger: ReactNode;
}

/**
 * Unlike `AccountDialog`'s room-limit field, there's no "unlimited weight"
 * concept for an asset — a blank field is treated the same as any other
 * parse failure.
 */
function parseWeightBps(raw: string): number {
  const parsed = bpsFromPercentField(raw);
  if (parsed.error) throw new Error(`Weight: ${parsed.error}`);
  if (parsed.bps === null) throw new Error('Weight is required');
  return parsed.bps;
}

export function AssetDialog({ sleeveId, asset, onSaved, trigger }: AssetDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {/* Radix unmounts this while closed, so the form always opens with fresh
            values and a cancelled edit never sticks. */}
        <AssetForm sleeveId={sleeveId} asset={asset} onSaved={onSaved} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AssetForm({
  sleeveId,
  asset,
  onSaved,
  onDone,
}: Omit<AssetDialogProps, 'trigger'> & { onDone: () => void }) {
  const editing = asset !== undefined;

  const [ticker, setTicker] = useState(asset?.ticker ?? '');
  const [label, setLabel] = useState(asset?.label ?? '');
  const [weightBps, setWeightBps] = useState(
    asset !== undefined ? percentFieldFromBps(asset.weightBps) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Parse everything before writing anything, so a bad field never leaves
      // the request half-built.
      const trimmedTicker = ticker.trim();
      if (trimmedTicker === '') {
        throw new Error('Ticker is required');
      }
      const parsedWeightBps = parseWeightBps(weightBps);

      const portfolio = editing
        ? await api.updateAsset(asset.id, {
            ticker: trimmedTicker,
            label,
            weightBps: parsedWeightBps,
          })
        : await api.createAsset({
            sleeveId,
            ticker: trimmedTicker,
            label,
            weightBps: parsedWeightBps,
          });

      onSaved(portfolio);
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? 'Edit asset' : 'Add asset'}</DialogTitle>
        <DialogDescription>
          A single holding within a sleeve, targeting a share of that sleeve.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="asset-ticker">Ticker</Label>
          <Input
            id="asset-ticker"
            value={ticker}
            onChange={(event) => setTicker(event.target.value.toUpperCase())}
            maxLength={12}
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="asset-label">Label</Label>
          <Input
            id="asset-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={60}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="asset-weight-bps">Weight % within sleeve</Label>
          <Input
            id="asset-weight-bps"
            inputMode="decimal"
            className="w-40 text-right tabular-nums"
            value={weightBps}
            onChange={(event) => setWeightBps(event.target.value)}
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogClose>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </>
  );
}
