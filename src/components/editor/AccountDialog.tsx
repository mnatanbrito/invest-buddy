import { useState, type ReactNode } from 'react';
import type { Account, PortfolioState } from '@shared/types';
import { api } from '@/lib/api';
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
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface AccountDialogProps {
  /** undefined = create mode, present = edit mode. */
  account?: Account;
  onSaved: (portfolio: PortfolioState) => void;
  /** The element that opens the dialog (a Button, typically), used with DialogTrigger asChild. */
  trigger: ReactNode;
}

/** Turns a cent amount into an editable field value, without currency symbols. */
const toField = (cents: number) => (cents / 100).toFixed(2);

/**
 * A blank field means "unlimited" (`null`), which is a meaningful value for
 * an account's contribution room (e.g. the non-registered account). A field
 * that's present but zero is also meaningful — e.g. a registered account with
 * no room left this year — and distinct from blank/unlimited, so it's handled
 * the same way `AssetDialog`'s `parseHoldingToCents` handles a zero holding.
 * Anything else that fails to parse is a genuine typo.
 */
function parseRoomLimitToCents(raw: string): number | null {
  const parsed = parseAmountToCents(raw);
  if (parsed.cents !== null) return parsed.cents;

  const normalized = raw.replace(/[$,\s]/g, '').trim();
  if (normalized === '') return null;
  if (Number(normalized) === 0) return 0;
  throw new Error(`Contribution room: ${parsed.error ?? 'not a valid amount'}`);
}

export function AccountDialog({ account, onSaved, trigger }: AccountDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {/* Radix unmounts this while closed, so the form always opens with fresh
            values and a cancelled edit never sticks. */}
        <AccountForm account={account} onSaved={onSaved} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AccountForm({
  account,
  onSaved,
  onDone,
}: Omit<AccountDialogProps, 'trigger'> & { onDone: () => void }) {
  const editing = account !== undefined;

  const [label, setLabel] = useState(account?.label ?? '');
  const [note, setNote] = useState(account?.note ?? '');
  const [roomLimit, setRoomLimit] = useState(
    account?.roomLimitCents != null ? toField(account.roomLimitCents) : '',
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
      const roomLimitCents = parseRoomLimitToCents(roomLimit);

      const portfolio = editing
        ? await api.updateAccount(account.id, { label: trimmedLabel, note, roomLimitCents })
        : await api.createAccount({ label: trimmedLabel, note, roomLimitCents });

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
        <DialogTitle>{editing ? 'Edit account' : 'Add account'}</DialogTitle>
        <DialogDescription>
          RRSP, TFSA, or a non-registered account. Leave contribution room blank for no limit.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="account-label">Label</Label>
          <Input
            id="account-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={60}
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="account-note">Note</Label>
          <Textarea
            id="account-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={500}
            rows={3}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="account-room-limit">Contribution room</Label>
          <Input
            id="account-room-limit"
            inputMode="decimal"
            className="w-40 text-right tabular-nums"
            value={roomLimit}
            onChange={(event) => setRoomLimit(event.target.value)}
            placeholder="No limit"
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
