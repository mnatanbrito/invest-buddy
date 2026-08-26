import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AllocationPlan, InvestmentRecord, PortfolioState } from '@shared/types';
import { allocationIssues, isFullyAllocated, toRebalanceUnits } from '@shared/allocation';
import { planDeposit } from '@shared/rebalance';
import { api } from '@/lib/api';
import { formatCents, parseAmountToCents } from '@/lib/money';
import { AllocationDiagram, type DiagramFlight } from '@/components/diagram/AllocationDiagram';
import { EmptyState } from '@/components/EmptyState';
import { HistoryPanel } from '@/components/HistoryPanel';
import { PortfolioEditor } from '@/components/editor/PortfolioEditor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** How long the tokens take to reach their boxes; the balances update as they land. */
const FLIGHT_LANDING_MS = 750;
const FLIGHT_CLEAR_MS = 1700;

export default function App() {
  const [portfolio, setPortfolio] = useState<PortfolioState | null>(null);
  const [history, setHistory] = useState<InvestmentRecord[]>([]);
  const [amount, setAmount] = useState('');
  const [flight, setFlight] = useState<DiagramFlight | null>(null);
  const [lastPlan, setLastPlan] = useState<AllocationPlan | null>(null);
  const [busy, setBusy] = useState<'investing' | 'undoing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `null` means "no explicit choice yet". Portfolio is `null` on first render, so this
  // can't be computed in `useState`'s initializer; instead it's set once, in-render (not
  // via an Effect — this is React's documented "adjusting state when a prop changes"
  // pattern), the first time `portfolio` has accounts to show, and never overwritten
  // after that so a later portfolio refresh doesn't clobber the user's manual toggle.
  // The `accounts.length > 0` check matters: on a fresh database the first non-null
  // portfolio is the empty one (rendered as `EmptyState` below), which would otherwise
  // lock `view` to `'edit'` before the user ever loads a real portfolio.
  const [view, setView] = useState<'plan' | 'edit' | null>(null);
  if (portfolio && portfolio.accounts.length > 0 && view === null) {
    setView(isFullyAllocated(portfolio) ? 'plan' : 'edit');
  }

  const refreshHistory = useCallback(async () => {
    setHistory(await api.history());
  }, []);

  useEffect(() => {
    Promise.all([api.portfolio(), api.history()])
      .then(([loadedPortfolio, loadedHistory]) => {
        setPortfolio(loadedPortfolio);
        setHistory(loadedHistory);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not reach the API'),
      );
  }, []);

  const parsed = useMemo(() => parseAmountToCents(amount), [amount]);

  /**
   * The preview runs the same engine the server will run on execute, so what the
   * diagram shows and what gets written can't disagree. The server still re-plans
   * authoritatively against locked rows.
   */
  const issues = useMemo(() => (portfolio ? allocationIssues(portfolio) : []), [portfolio]);

  const preview = useMemo(() => {
    if (!portfolio || parsed.cents === null || flight || issues.length > 0) return null;
    return planDeposit(toRebalanceUnits(portfolio), portfolio.accounts, parsed.cents);
  }, [portfolio, parsed.cents, flight, issues]);

  const invest = async () => {
    if (parsed.cents === null || !portfolio) return;
    setBusy('investing');
    setError(null);
    try {
      const result = await api.invest(parsed.cents);
      setFlight({ key: Date.now(), plan: result.plan });
      setLastPlan(result.plan);
      setAmount('');

      // Let the balances tick over as the tokens arrive, not before they leave.
      window.setTimeout(() => setPortfolio(result.portfolio), FLIGHT_LANDING_MS);
      window.setTimeout(() => setFlight(null), FLIGHT_CLEAR_MS);

      await refreshHistory();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record that investment');
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    setBusy('undoing');
    setError(null);
    try {
      setPortfolio(await api.undo());
      setLastPlan(null);
      await refreshHistory();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not undo');
    } finally {
      setBusy(null);
    }
  };

  if (error && !portfolio) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <Alert variant="destructive">
          <AlertTitle>Cannot load your portfolio</AlertTitle>
          <AlertDescription>
            {error}. Check that Postgres is running and that `pnpm dev:api` has started.
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  if (!portfolio) {
    return <main className="mx-auto max-w-2xl p-8 text-muted-foreground">Loading portfolio…</main>;
  }

  if (portfolio.accounts.length === 0) {
    return <EmptyState onLoaded={setPortfolio} />;
  }

  const shown = preview ?? (flight ? flight.plan : null);
  const exhaustedAccounts = portfolio.accounts.filter((a) => a.roomRemainingCents === 0);
  const canInvest = parsed.cents !== null && busy === null && issues.length === 0;
  // `view` is only ever `null` before the render-phase assignment above runs, which
  // happens the same render `portfolio` first has accounts — by the time we're here
  // (past the `!portfolio` and empty-accounts early returns) it's already been set.
  // `?? 'edit'` just keeps the type-checker and runtime both honest about that.
  const currentView = view ?? 'edit';

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invest Buddy</h1>
          <p className="text-sm text-muted-foreground">
            Drift-aware rebalancing across your accounts.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-xs text-muted-foreground">Portfolio value</div>
            <div className="text-xl font-semibold tabular-nums">{formatCents(portfolio.totalCents)}</div>
          </div>
          <div className="inline-flex rounded-md border p-0.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                'rounded-sm px-3',
                currentView === 'plan' && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
              )}
              onClick={() => setView('plan')}
            >
              Plan
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                'rounded-sm px-3',
                currentView === 'edit' && 'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
              )}
              onClick={() => setView('edit')}
            >
              Edit
            </Button>
          </div>
        </div>
      </header>

      {currentView === 'edit' ? (
        <PortfolioEditor portfolio={portfolio} onSaved={setPortfolio} />
      ) : (
        <>
          {exhaustedAccounts.length > 0 && (
            <Alert variant="destructive">
              <AlertTitle>
                {exhaustedAccounts.map((a) => a.label).join(' and ')} contribution room is used up
              </AlertTitle>
              <AlertDescription>
                Deposits destined for {exhaustedAccounts.length > 1 ? 'those accounts' : 'that account'} will
                be held back as cash rather than moved elsewhere. Update your room in the Edit view if this
                is a new contribution year.
              </AlertDescription>
            </Alert>
          )}

          <section className="rounded-xl border p-4 space-y-4">
            <form
              className="flex flex-wrap items-start gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void invest();
              }}
            >
              <div className="flex-1 min-w-56 space-y-1.5">
                <label htmlFor="amount" className="text-sm font-medium">
                  Amount to invest
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="amount"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="5,000.00"
                    className="pl-7 text-lg tabular-nums"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    aria-invalid={parsed.error !== null}
                    aria-describedby={parsed.error ? 'amount-error' : undefined}
                  />
                </div>
                {parsed.error && (
                  <p id="amount-error" className="text-sm text-destructive">
                    {parsed.error}
                  </p>
                )}
              </div>

              <Button type="submit" size="lg" className="mt-6.5" disabled={!canInvest}>
                {busy === 'investing' ? 'Investing…' : 'Invest'}
              </Button>
            </form>

            {issues.length > 0 && (
              <p className="text-sm text-destructive">
                {issues[0].message}{' '}
                <button type="button" className="underline" onClick={() => setView('edit')}>
                  Fix in Edit view
                </button>
              </p>
            )}

            {shown && shown.unallocatedCents > 0 && (
              <p className="text-sm text-destructive">
                {formatCents(shown.allocatedCents)} will be invested;{' '}
                {formatCents(shown.unallocatedCents)} stays as cash because contribution room ran out in{' '}
                {shown.cappedAccountIds
                  .map((id) => portfolio.accounts.find((a) => a.id === id)?.label ?? id)
                  .join(' and ')}
                .
              </p>
            )}

            {preview && preview.unallocatedCents === 0 && (
              <p className="text-sm text-muted-foreground">
                All {formatCents(preview.requestedCents)} fits. Amounts flow to whichever assets sit
                furthest below their target.
              </p>
            )}

            {lastPlan && !preview && (
              <p className="text-sm text-muted-foreground">
                Last investment: {formatCents(lastPlan.allocatedCents)} allocated across{' '}
                {lastPlan.lines.filter((line) => line.amountCents > 0).length} assets.
              </p>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </section>

          <AllocationDiagram portfolio={portfolio} preview={preview} flight={flight} />

          <HistoryPanel
            history={history}
            portfolio={portfolio}
            onUndo={() => void undo()}
            undoing={busy === 'undoing'}
          />
        </>
      )}
    </main>
  );
}
