import { useState } from 'react';
import { Trash2Icon } from 'lucide-react';
import { ApiError } from '@/lib/api';
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

interface DeleteEntityButtonProps {
  /** e.g. "Delete RRSP" — used as both the trigger's accessible name and the confirm dialog's context. */
  label: string;
  /** Caller supplies the actual api.deleteX(id) call. */
  onDelete: () => Promise<void>;
}

/**
 * A small reusable confirm-then-delete trigger shared by account/sleeve/asset
 * rows and cards. Mounted-only-while-open via Radix unmounting (same pattern
 * as `SettingsDialog`), so a cancelled or failed attempt never leaves stale
 * error state behind the next time the dialog opens.
 */
export function DeleteEntityButton({ label, onDelete }: DeleteEntityButtonProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label}>
          <Trash2Icon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <ConfirmDeleteForm label={label} onDelete={onDelete} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDeleteForm({
  label,
  onDelete,
  onDone,
}: DeleteEntityButtonProps & { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      onDone();
    } catch (caught) {
      // A 409 is the server's holdings/history-blocked message: actionable, so
      // the user should see it without the dialog vanishing. Anything else
      // (network failure, unexpected status) gets a generic inline message and
      // also keeps the dialog open, rather than letting it propagate — this
      // component is meant to be a self-contained, drop-in trigger, and every
      // call site would otherwise need to reimplement its own error surface
      // for a failure this dialog is already positioned to show.
      setError(
        caught instanceof ApiError && caught.status === 409
          ? caught.message
          : 'Could not delete. Please try again.',
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{label}?</DialogTitle>
        <DialogDescription>This can&apos;t be undone.</DialogDescription>
      </DialogHeader>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <DialogFooter>
        <DialogClose asChild>
          <Button variant="ghost">Cancel</Button>
        </DialogClose>
        <Button variant="destructive" onClick={() => void confirm()} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </DialogFooter>
    </>
  );
}
