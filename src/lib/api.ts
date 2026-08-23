import type { AllocationPlan, InvestmentRecord, PortfolioState } from '@shared/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export interface InvestResult {
  investmentId: number;
  plan: AllocationPlan;
  portfolio: PortfolioState;
}

export const api = {
  portfolio: () => request<PortfolioState>('/api/portfolio'),

  preview: (amountCents: number) =>
    request<AllocationPlan>('/api/preview', {
      method: 'POST',
      body: JSON.stringify({ amountCents }),
    }),

  invest: (amountCents: number) =>
    request<InvestResult>('/api/invest', {
      method: 'POST',
      body: JSON.stringify({ amountCents }),
    }),

  undo: () => request<PortfolioState>('/api/undo', { method: 'POST' }),

  setRoom: (accountId: string, roomLimitCents: number) =>
    request<PortfolioState>(`/api/accounts/${accountId}/room`, {
      method: 'PUT',
      body: JSON.stringify({ roomLimitCents }),
    }),

  setHoldings: (holdings: Record<string, number>) =>
    request<PortfolioState>('/api/holdings', {
      method: 'PUT',
      body: JSON.stringify({ holdings }),
    }),

  history: () => request<InvestmentRecord[]>('/api/history'),
};
