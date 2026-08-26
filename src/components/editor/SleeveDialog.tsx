import { useState, type ReactNode } from 'react';
import type { PortfolioState, Sleeve } from '@shared/types';
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

interface SleeveDialogProps {
  /** The parent account this sleeve belongs to (or will belong to on create). */
  accountId: string;
  /** undefined = create mode, present = edit mode. */
  sleeve?: Sleeve;
  onSaved: (portfolio: PortfolioState) => void;
  /** The element that opens the dialog (a Button, typically), used with DialogTrigger asChild. */
  trigger: ReactNode;
}

/**
 * Unlike `AccountDialog`'s room-limit field, there's no "unlimited target"
 * concept for a sleeve — a blank field is treated the same as any other
 * parse failure.
 */
function parseTargetBps(raw: string): number {
  const parsed = bpsFromPercentField(raw);
  if (parsed.error) throw new Error(`Target: ${parsed.error}`);
  if (parsed.bps === null) throw new Error('Target is required');
  return parsed.bps;
}

export function SleeveDialog({ accountId, sleeve, onSaved, trigger }: SleeveDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {/* Radix unmounts this while closed, so the form always opens with fresh
            values and a cancelled edit never sticks. */}
        <SleeveForm
          accountId={accountId}
          sleeve={sleeve}
          onSaved={onSaved}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function SleeveForm({
  accountId,
  sleeve,
  onSaved,
  onDone,
}: Omit<SleeveDialogProps, 'trigger'> & { onDone: () => void }) {
  const editing = sleeve !== undefined;

  const [label, setLabel] = useState(sleeve?.label ?? '');
  const [targetBps, setTargetBps] = useState(
    sleeve !== undefined ? percentFieldFromBps(sleeve.targetBps) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Parse everything before writing anything, so a bad field never leaves
      // the request half-built.
      const trimmedLabel = label.trim();
      if (trimmedLabel === '') {
        throw new Error('Label is required');
      }
      const parsedTargetBps = parseTargetBps(targetBps);

      const portfolio = editing
        ? await api.updateSleeve(sleeve.id, { label: trimmedLabel, targetBps: parsedTargetBps })
        : await api.createSleeve({ accountId, label: trimmedLabel, targetBps: parsedTargetBps });

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
        <DialogTitle>{editing ? 'Edit sleeve' : 'Add sleeve'}</DialogTitle>
        <DialogDescription>
          A group of assets within an account, targeting a share of the whole portfolio.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="sleeve-label">Label</Label>
          <Input
            id="sleeve-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={60}
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="sleeve-target-bps">Target % of portfolio</Label>
          <Input
            id="sleeve-target-bps"
            inputMode="decimal"
            className="w-40 text-right tabular-nums"
            value={targetBps}
            onChange={(event) => setTargetBps(event.target.value)}
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
