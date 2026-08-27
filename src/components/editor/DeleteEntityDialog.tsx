import { useState } from 'react';
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
} from '@/components/ui/dialog';

export interface DeleteEntityDialogProps {
  /** e.g. "RRSP" — the bare entity name; the component composes "Delete {entityLabel}" itself. */
  entityLabel: string;
  /** Caller supplies the actual api.deleteX(id) call. */
  onDelete: () => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * A small reusable confirm-then-delete dialog shared by account/sleeve/asset
 * rows and cards. Mounted-only-while-open via Radix unmounting (same pattern
 * as `AssetDialog`), so a cancelled or failed attempt never leaves stale
 * error state behind the next time the dialog opens.
 */
export function DeleteEntityDialog({
  entityLabel,
  onDelete,
  open,
  onOpenChange,
}: DeleteEntityDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <ConfirmDeleteForm
          entityLabel={entityLabel}
          onDelete={onDelete}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDeleteForm({
  entityLabel,
  onDelete,
  onDone,
}: Omit<DeleteEntityDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) {
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
        <DialogTitle>Delete {entityLabel}?</DialogTitle>
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
