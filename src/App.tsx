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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

/** How long the tokens take to reach their boxes; the balances update as they land. */
const FLIGHT_LANDING_MS = 750;
const FLIGHT_CLEAR_MS = 1700;

export default function App() {
  const [portfolio, setPortfolio] = useState<PortfolioState | null>(null);
  const [history, setHistory] = useState<InvestmentRecord[]>([]);
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [prioritizedAccountIds, setPrioritizedAccountIds] = useState<string[]>([]);
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

  // The state array filtered to accounts that still have a finite contribution room —
  // a stale id whose account lost its room limit since it was picked is ignored.
  // Memoised so `preview` below gets a stable reference to depend on.
  const activePriorities = useMemo(() => {
    const prioritizable = portfolio?.accounts.filter((a) => a.roomRemainingCents !== null) ?? [];
    return prioritizedAccountIds.filter((id) => prioritizable.some((a) => a.id === id));
  }, [prioritizedAccountIds, portfolio]);

  const preview = useMemo(() => {
    if (!portfolio || parsed.cents === null || flight || issues.length > 0) return null;
    return planDeposit(
      toRebalanceUnits(portfolio),
      portfolio.accounts,
      parsed.cents,
      activePriorities,
    );
  }, [portfolio, parsed.cents, flight, issues, activePriorities]);

  const invest = async () => {
    if (parsed.cents === null || !portfolio) return;
    setBusy('investing');
    setError(null);
    try {
      const result = await api.invest(parsed.cents, label, activePriorities);
      setFlight({ key: Date.now(), plan: result.plan });
      setLastPlan(result.plan);
      setAmount('');
      setLabel('');

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
  // A prioritized account is capped on purpose, so it isn't a case of room "running
  // out" — the prioritization messages below already account for that money.
  const roomRanOutAccounts =
    shown?.cappedAccountIds.filter((id) => !shown.prioritizedAccountIds.includes(id)) ?? [];
  const exhaustedAccounts = portfolio.accounts.filter((a) => a.roomRemainingCents === 0);
  // Only accounts with a finite contribution room can be prioritized. `activePriorities`
  // (memoised above) is the same list narrowed to the ids currently picked.
  const prioritizableAccounts = portfolio.accounts.filter((a) => a.roomRemainingCents !== null);
  const togglePriority = (id: string) =>
    setPrioritizedAccountIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
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
          <Tabs value={currentView} onValueChange={(value) => setView(value as 'plan' | 'edit')}>
            <TabsList>
              <TabsTrigger value="plan">Plan</TabsTrigger>
              <TabsTrigger value="edit">Edit</TabsTrigger>
            </TabsList>
          </Tabs>
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

              <div className="flex-1 min-w-56 space-y-1.5">
                <label htmlFor="label" className="text-sm font-medium">
                  Label (optional)
                </label>
                <Input
                  id="label"
                  autoComplete="off"
                  placeholder="Year-end bonus"
                  maxLength={60}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>

              {prioritizableAccounts.length > 0 && (
                <div className="min-w-56 space-y-1.5">
                  <span id="prioritize-label" className="text-sm font-medium">
                    Prioritize filling
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        className="w-full justify-between"
                        aria-labelledby="prioritize-label"
                      >
                        {activePriorities.length === 0
                          ? 'No priority'
                          : activePriorities
                              .map(
                                (id) =>
                                  portfolio.accounts.find((a) => a.id === id)?.label ?? id,
                              )
                              .join(', ')}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      <DropdownMenuLabel>Fill to contribution room first</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {prioritizableAccounts.map((account) => (
                        <DropdownMenuCheckboxItem
                          key={account.id}
                          checked={activePriorities.includes(account.id)}
                          onCheckedChange={() => togglePriority(account.id)}
                          onSelect={(event) => event.preventDefault()}
                        >
                          {account.label}
                        </DropdownMenuCheckboxItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}

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

            {shown && shown.unallocatedCents > 0 && roomRanOutAccounts.length > 0 && (
              <p className="text-sm text-destructive">
                {formatCents(shown.allocatedCents)} will be invested;{' '}
                {formatCents(shown.unallocatedCents)} stays as cash because contribution room ran out in{' '}
                {roomRanOutAccounts
                  .map((id) => portfolio.accounts.find((a) => a.id === id)?.label ?? id)
                  .join(' and ')}
                .
              </p>
            )}

            {preview && preview.redirectedCents > 0 && (
              <p className="text-sm text-muted-foreground">
                Filling{' '}
                {preview.prioritizedAccountIds
                  .map((id) => portfolio.accounts.find((a) => a.id === id)?.label ?? id)
                  .join(' and ')}{' '}
                to contribution room first — {formatCents(preview.redirectedCents)} redirected to{' '}
                {[
                  ...new Set(
                    preview.lines
                      .filter((line) => line.redirectedCents > 0)
                      .map(
                        (line) =>
                          portfolio.accounts.find((a) => a.id === line.accountId)?.label ??
                          line.accountId,
                      ),
                  ),
                ].join(' and ')}{' '}
                to keep your asset mix.
              </p>
            )}

            {preview &&
              preview.lines
                .filter(
                  (line) =>
                    line.blockedCents > 0 &&
                    line.redirectedCents === 0 &&
                    preview.prioritizedAccountIds.includes(line.accountId),
                )
                .map((line) => {
                  const ticker = portfolio.sleeves
                    .flatMap((s) => s.assets)
                    .find((a) => a.id === line.assetId)?.ticker;
                  const accountLabel =
                    portfolio.accounts.find((a) => a.id === line.accountId)?.label ?? line.accountId;
                  return (
                    <p key={line.assetId} className="text-sm text-destructive">
                      {formatCents(line.blockedCents)} from {accountLabel} couldn&apos;t be
                      redirected — no other sleeve holds {ticker ?? 'that ticker'} — and stays as
                      cash.
                    </p>
                  );
                })}

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
