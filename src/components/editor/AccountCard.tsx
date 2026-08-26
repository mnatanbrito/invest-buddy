import { ChevronDownIcon, ChevronUpIcon, PencilIcon } from 'lucide-react';
import type { Account, PortfolioState, Sleeve } from '@shared/types';
import { MAX_SLEEVES } from '@shared/allocation';
import { api } from '@/lib/api';
import { moveSortOrder } from '@/lib/editor';
import { formatCents } from '@/lib/money';
import { AccountDialog } from '@/components/editor/AccountDialog';
import { DeleteEntityButton } from '@/components/editor/DeleteEntityButton';
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
        <CardAction className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${account.label} up`}
            disabled={isFirst}
            onClick={() => void move('up')}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${account.label} down`}
            disabled={isLast}
            onClick={() => void move('down')}
          >
            <ChevronDownIcon />
          </Button>
          <AccountDialog
            account={account}
            onSaved={onSaved}
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${account.label}`}>
                <PencilIcon />
              </Button>
            }
          />
          <DeleteEntityButton
            entityLabel={account.label}
            onDelete={async () => onSaved(await api.deleteAccount(account.id))}
          />
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Sleeves</h3>
          <SleeveDialog
            accountId={account.id}
            onSaved={onSaved}
            trigger={
              <Button
                variant="outline"
                size="sm"
                disabled={sleevesMaxed}
                title={sleevesMaxed ? `Portfolio already has ${MAX_SLEEVES} sleeves` : undefined}
              >
                Add sleeve
              </Button>
            }
          />
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
