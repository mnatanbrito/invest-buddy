import type { AllocationPlan, InvestmentRecord, PortfolioState } from '@shared/types';

/** A non-2xx API response, carrying the HTTP status so callers can branch on it
 * (e.g. `DeleteEntityButton` treats 409 — a holdings/history block — differently
 * from any other failure). */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

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
    throw new ApiError(message, response.status);
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

  loadExample: () => request<PortfolioState>('/api/presets/example', { method: 'POST' }),

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

  setHoldings: (holdings: Record<string, number>) =>
    request<PortfolioState>('/api/holdings', {
      method: 'PUT',
      body: JSON.stringify({ holdings }),
    }),

  history: () => request<InvestmentRecord[]>('/api/history'),

  createAccount: (input: { label: string; note?: string; roomLimitCents?: number | null }) =>
    request<PortfolioState>('/api/accounts', { method: 'POST', body: JSON.stringify(input) }),

  updateAccount: (
    id: string,
    patch: Partial<{ label: string; note: string; roomLimitCents: number | null; sortOrder: number }>,
  ) => request<PortfolioState>(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteAccount: (id: string) =>
    request<PortfolioState>(`/api/accounts/${id}`, { method: 'DELETE' }),

  createSleeve: (input: { accountId: string; label: string; targetBps: number }) =>
    request<PortfolioState>('/api/sleeves', { method: 'POST', body: JSON.stringify(input) }),

  updateSleeve: (id: string, patch: Partial<{ label: string; targetBps: number; sortOrder: number }>) =>
    request<PortfolioState>(`/api/sleeves/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteSleeve: (id: string) =>
    request<PortfolioState>(`/api/sleeves/${id}`, { method: 'DELETE' }),

  createAsset: (input: { sleeveId: string; ticker: string; label?: string; weightBps: number }) =>
    request<PortfolioState>('/api/assets', { method: 'POST', body: JSON.stringify(input) }),

  updateAsset: (
    id: string,
    patch: Partial<{ ticker: string; label: string; weightBps: number; sortOrder: number }>,
  ) => request<PortfolioState>(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteAsset: (id: string) =>
    request<PortfolioState>(`/api/assets/${id}`, { method: 'DELETE' }),
};
