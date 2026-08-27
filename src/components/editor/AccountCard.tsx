import { useState } from 'react';
import type { Account, PortfolioState, Sleeve } from '@shared/types';
import { MAX_SLEEVES } from '@shared/allocation';
import { api } from '@/lib/api';
import { moveSortOrder } from '@/lib/editor';
import { formatCents } from '@/lib/money';
import { AccountDialog } from '@/components/editor/AccountDialog';
import { DeleteEntityDialog } from '@/components/editor/DeleteEntityDialog';
import { EntityActionsMenu } from '@/components/editor/EntityActionsMenu';
import { SleeveDialog } from '@/components/editor/SleeveDialog';
import { SleeveRow } from '@/components/editor/SleeveRow';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface AccountCardProps {
  account: Account;
  /** portfolio.accounts, already ordered — for reorder computation. */
  siblingAccounts: Account[];
  /** This account's own sleeves, already filtered and ordered. */
  sleeves: Sleeve[];
  /** portfolio.sleeves.length — the sleeve cap is portfolio-wide, not per-account. */
  totalSleeveCount: number;
  onSaved: (portfolio: PortfolioState) => void;
}

export function AccountCard({
  account,
  siblingAccounts,
  sleeves,
  totalSleeveCount,
  onSaved,
}: AccountCardProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addSleeveOpen, setAddSleeveOpen] = useState(false);

  const index = siblingAccounts.findIndex((sibling) => sibling.id === account.id);
  const isFirst = index <= 0;
  const isLast = index === -1 || index === siblingAccounts.length - 1;

  const move = async (direction: 'up' | 'down') => {
    const pairs = moveSortOrder(siblingAccounts, account.id, direction);
    if (pairs.length === 0) return;
    try {
      // The second call's response is authoritative: it reflects both writes.
      await api.updateAccount(pairs[0].id, { sortOrder: pairs[0].sortOrder });
      onSaved(await api.updateAccount(pairs[1].id, { sortOrder: pairs[1].sortOrder }));
    } catch (caught) {
      // Rare (a 404 would mean the row was deleted concurrently) — no toast
      // system is wired up in this app yet, so a plain alert is enough here.
      console.error('Could not reorder account', caught);
      window.alert('Could not reorder that account. Please refresh and try again.');
    }
  };

  // Sleeve cap is portfolio-wide (MAX_SLEEVES total across all accounts), so
  // this deliberately checks totalSleeveCount, not sleeves.length.
  const sleevesMaxed = totalSleeveCount >= MAX_SLEEVES;
  const roomLabel = account.roomLimitCents === null ? 'unlimited' : formatCents(account.roomLimitCents);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{account.label}</CardTitle>
        <div className="space-y-0.5 text-sm text-muted-foreground">
          {account.note && <p>{account.note}</p>}
          <p>
            {formatCents(account.roomUsedCents)} of {roomLabel} room used ·{' '}
            {formatCents(account.holdingCents)} held
          </p>
        </div>
        <CardAction>
          <EntityActionsMenu
            entityLabel={account.label}
            isFirst={isFirst}
            isLast={isLast}
            onMoveUp={() => void move('up')}
            onMoveDown={() => void move('down')}
            onEdit={() => setEditOpen(true)}
            onDelete={() => setDeleteOpen(true)}
          />
          <AccountDialog account={account} onSaved={onSaved} open={editOpen} onOpenChange={setEditOpen} />
          <DeleteEntityDialog
            entityLabel={account.label}
            onDelete={async () => onSaved(await api.deleteAccount(account.id))}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
          />
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Sleeves</h3>
          <div className="flex flex-col items-end gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={sleevesMaxed}
              onClick={() => setAddSleeveOpen(true)}
            >
              Add sleeve
            </Button>
            <SleeveDialog
              accountId={account.id}
              onSaved={onSaved}
              open={addSleeveOpen}
              onOpenChange={setAddSleeveOpen}
            />
            {sleevesMaxed && (
              <span className="text-xs text-muted-foreground">
                The portfolio already has the maximum of {MAX_SLEEVES} sleeves
              </span>
            )}
          </div>
        </div>

        {sleeves.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sleeves yet.</p>
        ) : (
          <div className="space-y-3">
            {sleeves.map((sleeve) => (
              <SleeveRow key={sleeve.id} sleeve={sleeve} siblingSleeves={sleeves} onSaved={onSaved} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
