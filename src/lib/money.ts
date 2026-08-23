const CAD = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const CAD_WHOLE = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatCents(cents: number): string {
  return CAD.format(cents / 100);
}

/** Compact form for the diagram, where two decimals on a five-figure number is noise. */
export function formatCentsShort(cents: number): string {
  if (cents === 0) return '$0';
  if (Math.abs(cents) >= 100_000) return CAD_WHOLE.format(cents / 100);
  return CAD.format(cents / 100);
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
}

export function formatDriftBps(bps: number): string {
  const sign = bps > 0 ? '+' : bps < 0 ? '−' : '';
  return `${sign}${(Math.abs(bps) / 100).toFixed(1)} pts`;
}

export interface ParsedAmount {
  cents: number | null;
  error: string | null;
}

/**
 * Parse what someone typed into a money field. Accepts "1,234.56", "$1234.56",
 * "1234". Rejects more than two decimal places outright rather than silently
 * rounding away part of the deposit.
 */
export function parseAmountToCents(raw: string): ParsedAmount {
  const trimmed = raw.trim();
  if (trimmed === '') return { cents: null, error: null };

  // Strip currency decoration, then re-trim. Internal whitespace is deliberately
  // NOT collapsed: "1 2" is ambiguous input, and reading it as $12 would be the
  // same silent misreading this function rejects a third decimal place for.
  const cleaned = trimmed.replace(/[$,]/g, '').trim();
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') {
    return { cents: null, error: 'Enter a dollar amount, for example 5,000' };
  }

  const [, decimals = ''] = cleaned.split('.');
  if (decimals.length > 2) {
    return { cents: null, error: 'At most two decimal places' };
  }

  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents)) return { cents: null, error: 'That number is too large' };
  if (cents <= 0) return { cents: null, error: 'Enter an amount greater than zero' };
  if (cents > 1_000_000_000_00) return { cents: null, error: 'That number is too large' };

  return { cents, error: null };
}
