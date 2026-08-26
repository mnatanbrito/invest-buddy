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
        <AccountDialog
          onSaved={onSaved}
          trigger={
            <Button
              disabled={accountsMaxed}
              title={accountsMaxed ? `Portfolio already has ${MAX_ACCOUNTS} accounts` : undefined}
            >
              Add account
            </Button>
          }
        />
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
