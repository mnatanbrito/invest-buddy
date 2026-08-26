import { useState } from 'react';
import type { PortfolioState } from '@shared/types';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface EmptyStateProps {
  onLoaded: (portfolio: PortfolioState) => void;
}

export function EmptyState({ onLoaded }: EmptyStateProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadExample = async () => {
    setLoading(true);
    setError(null);
    try {
      onLoaded(await api.loadExample());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the example portfolio');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>Welcome to Invest Buddy</CardTitle>
          <CardDescription>
            Your portfolio is empty. Load a sample RRSP/TFSA/non-registered portfolio to see how
            drift-aware rebalancing works.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={() => void loadExample()} disabled={loading} size="lg">
            {loading ? 'Loading…' : 'Load example portfolio'}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </main>
  );
}
