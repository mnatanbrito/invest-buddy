import { useState } from 'react';
import type { Asset, PortfolioState } from '@shared/types';
import { api } from '@/lib/api';
import { bpsFromPercentField, percentFieldFromBps } from '@/lib/editor';
import { parseAmountToCents } from '@/lib/money';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface AssetDialogProps {
  /** The parent sleeve this asset belongs to (or will belong to on create). */
  sleeveId: string;
  /** undefined = create mode, present = edit mode. */
  asset?: Asset;
  onSaved: (portfolio: PortfolioState) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

/** Turns a cent amount into an editable field value, without currency symbols. */
const toField = (cents: number) => (cents / 100).toFixed(2);

/**
 * A blank or zero field means "holds nothing", which is a legitimate value for
 * an asset. Anything else that fails to parse is a genuine typo.
 */
function parseHoldingToCents(raw: string): number {
  const parsed = parseAmountToCents(raw);
  if (parsed.cents !== null) return parsed.cents;

  const normalized = raw.replace(/[$,\s]/g, '').trim();
  if (normalized === '' || Number(normalized) === 0) return 0;
  throw new Error(`Current holding: ${parsed.error ?? 'not a valid amount'}`);
}

export function AssetDialog({ sleeveId, asset, onSaved, open, onOpenChange }: AssetDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Radix unmounts this while closed, so the form always opens with fresh
            values and a cancelled edit never sticks. */}
        <AssetForm
          sleeveId={sleeveId}
          asset={asset}
          onSaved={onSaved}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function AssetForm({
  sleeveId,
  asset,
  onSaved,
  onDone,
}: Omit<AssetDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) {
  const editing = asset !== undefined;

  const [ticker, setTicker] = useState(asset?.ticker ?? '');
  const [label, setLabel] = useState(asset?.label ?? '');
  const [weightBps, setWeightBps] = useState(
    asset !== undefined ? percentFieldFromBps(asset.weightBps) : '',
  );
  const [holding, setHolding] = useState(asset ? toField(asset.holdingCents) : '');
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
      const parsedHoldingCents = editing ? parseHoldingToCents(holding) : null;

      let portfolio = editing
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

      // Holdings live behind a separate endpoint, so a changed holding needs a
      // second call — its response is the authoritative one since it reflects
      // both writes.
      if (editing && parsedHoldingCents !== null && parsedHoldingCents !== asset.holdingCents) {
        portfolio = await api.setHoldings({ [asset.id]: parsedHoldingCents });
      }

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

        {editing && (
          <div className="space-y-1.5">
            <Label htmlFor="asset-holding">Current holding</Label>
            <Input
              id="asset-holding"
              inputMode="decimal"
              className="w-40 text-right tabular-nums"
              value={holding}
              onChange={(event) => setHolding(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              What you already hold in this asset, if anything.
            </p>
          </div>
        )}

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
