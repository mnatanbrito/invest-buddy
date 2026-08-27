import { useState } from 'react';
import type { PortfolioState } from '@shared/types';
import { MAX_ACCOUNTS, sleeveTargetTotalBps } from '@shared/allocation';
import { formatBps, formatCents } from '@/lib/money';
import { cn } from '@/lib/utils';
import { AccountCard } from '@/components/editor/AccountCard';
import { AccountDialog } from '@/components/editor/AccountDialog';
import { Button } from '@/components/ui/button';

interface PortfolioEditorProps {
  portfolio: PortfolioState;
  onSaved: (portfolio: PortfolioState) => void;
}

export function PortfolioEditor({ portfolio, onSaved }: PortfolioEditorProps) {
  const [addAccountOpen, setAddAccountOpen] = useState(false);

  const targetTotal = sleeveTargetTotalBps(portfolio.sleeves);
  const targetOk = targetTotal === 10_000;
  const accountsMaxed = portfolio.accounts.length >= MAX_ACCOUNTS;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Portfolio structure</h2>
          <p className="text-sm text-muted-foreground">
            {formatCents(portfolio.totalCents)} total · sleeve targets add up to{' '}
            <span className={cn('tabular-nums', !targetOk && 'text-destructive')}>
              {formatBps(targetTotal)}
            </span>{' '}
            of 100%
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button disabled={accountsMaxed} onClick={() => setAddAccountOpen(true)}>
            Add account
          </Button>
          <AccountDialog onSaved={onSaved} open={addAccountOpen} onOpenChange={setAddAccountOpen} />
          {accountsMaxed && (
            <span className="text-xs text-muted-foreground">Maximum of {MAX_ACCOUNTS} accounts reached</span>
          )}
        </div>
      </header>

      <div className="space-y-4">
        {portfolio.accounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            siblingAccounts={portfolio.accounts}
            sleeves={portfolio.sleeves.filter((sleeve) => sleeve.accountId === account.id)}
            totalSleeveCount={portfolio.sleeves.length}
            onSaved={onSaved}
          />
        ))}
      </div>
    </div>
  );
}
