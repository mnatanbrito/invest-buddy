import { useState } from 'react';
import type { PortfolioState } from '@shared/types';
import { api } from '@/lib/api';
import { formatCents, parseAmountToCents } from '@/lib/money';
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
import { Separator } from '@/components/ui/separator';

interface SettingsDialogProps {
  portfolio: PortfolioState;
  onSaved: (portfolio: PortfolioState) => void;
}

/** Turns a cent amount into an editable field value, without currency symbols. */
const toField = (cents: number) => (cents / 100).toFixed(2);

/**
 * A blank or zero field means "none", which is a meaningful value for both room
 * and holdings. Anything else that fails to parse is a genuine typo.
 */
function parseFieldToCents(raw: string, label: string): number {
  const parsed = parseAmountToCents(raw);
  if (parsed.cents !== null) return parsed.cents;

  const normalized = raw.replace(/[$,\s]/g, '').trim();
  if (normalized === '' || Number(normalized) === 0) return 0;
  throw new Error(`${label}: ${parsed.error ?? 'not a valid amount'}`);
}

export function SettingsDialog({ portfolio, onSaved }: SettingsDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Settings</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        {/* Radix unmounts this while closed, so the form always opens with fresh
            values read from the current portfolio and a cancelled edit never sticks. */}
        <SettingsForm portfolio={portfolio} onSaved={onSaved} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function SettingsForm({
  portfolio,
  onSaved,
  onDone,
}: SettingsDialogProps & { onDone: () => void }) {
  const registered = portfolio.accounts.filter((account) => account.roomLimitCents !== null);

  const [rooms, setRooms] = useState<Record<string, string>>(() =>
    Object.fromEntries(registered.map((account) => [account.id, toField(account.roomLimitCents!)])),
  );
  const [holdings, setHoldings] = useState<Record<string, string>>(() =>
    Object.fromEntries(portfolio.sleeves.map((sleeve) => [sleeve.id, toField(sleeve.holdingCents)])),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Parse everything before writing anything, so a typo in the last field
      // cannot leave the earlier ones half-saved.
      const roomCents = registered.map((account) => ({
        id: account.id,
        cents: parseFieldToCents(rooms[account.id] ?? '', `${account.label} contribution room`),
      }));
      const holdingCents = Object.fromEntries(
        portfolio.sleeves.map((sleeve) => [
          sleeve.id,
          parseFieldToCents(holdings[sleeve.id] ?? '', `${sleeve.tickers} holding`),
        ]),
      );

      for (const { id, cents } of roomCents) {
        await api.setRoom(id, cents);
      }
      // Holdings go last, and its response carries the fully updated portfolio.
      onSaved(await api.setHoldings(holdingCents));
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
        <DialogTitle>Contribution room and opening balances</DialogTitle>
        <DialogDescription>
          Room figures come from your CRA Notice of Assessment and My Account. The values shipped
          with this app are placeholders, not your real limits.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Total contribution room</h3>
          {registered.map((account) => (
            <div key={account.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
              <Label htmlFor={`room-${account.id}`} className="flex flex-col items-start gap-0.5">
                <span>{account.label}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {formatCents(account.roomUsedCents)} used so far
                </span>
              </Label>
              <Input
                id={`room-${account.id}`}
                inputMode="decimal"
                className="w-40 text-right tabular-nums"
                value={rooms[account.id] ?? ''}
                onChange={(event) =>
                  setRooms((prev) => ({ ...prev, [account.id]: event.target.value }))
                }
              />
            </div>
          ))}
        </div>

        <Separator />

        <div className="space-y-3">
          <h3 className="text-sm font-medium">Current holdings</h3>
          <p className="text-xs text-muted-foreground">
            Set these once if you already hold these ETFs. Rebalancing uses them to decide which
            sleeves are underweight.
          </p>
          {portfolio.sleeves.map((sleeve) => (
            <div key={sleeve.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
              <Label htmlFor={`holding-${sleeve.id}`} className="flex flex-col items-start gap-0.5">
                <span>{sleeve.tickers}</span>
                <span className="text-xs font-normal text-muted-foreground">{sleeve.label}</span>
              </Label>
              <Input
                id={`holding-${sleeve.id}`}
                inputMode="decimal"
                className="w-40 text-right tabular-nums"
                value={holdings[sleeve.id] ?? ''}
                onChange={(event) =>
                  setHoldings((prev) => ({ ...prev, [sleeve.id]: event.target.value }))
                }
              />
            </div>
          ))}
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
