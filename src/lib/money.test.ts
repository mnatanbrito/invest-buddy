import { describe, expect, it } from 'vitest';
import {
  formatBps,
  formatCents,
  formatCentsShort,
  formatDriftBps,
  parseAmountToCents,
} from './money';

describe('parseAmountToCents', () => {
  it('accepts the shapes a person actually types', () => {
    expect(parseAmountToCents('1234')).toEqual({ cents: 123_400, error: null });
    expect(parseAmountToCents('1,234.56')).toEqual({ cents: 123_456, error: null });
    expect(parseAmountToCents('$1234.56')).toEqual({ cents: 123_456, error: null });
    expect(parseAmountToCents('  1234  ')).toEqual({ cents: 123_400, error: null });
    expect(parseAmountToCents('$ 1,234')).toEqual({ cents: 123_400, error: null });
    expect(parseAmountToCents('0.01')).toEqual({ cents: 1, error: null });
    expect(parseAmountToCents('.5')).toEqual({ cents: 50, error: null });
  });

  it('treats an empty field as "nothing typed yet", not as an error', () => {
    // App.tsx keys the Invest button off cents !== null, and shows error only when
    // it is non-null, so an empty field must produce neither.
    expect(parseAmountToCents('')).toEqual({ cents: null, error: null });
    expect(parseAmountToCents('   ')).toEqual({ cents: null, error: null });
  });

  it('rejects a third decimal place rather than silently rounding it away', () => {
    expect(parseAmountToCents('1.234')).toEqual({
      cents: null,
      error: 'At most two decimal places',
    });
    // Would otherwise round to a cent the user never typed.
    expect(parseAmountToCents('0.005').cents).toBeNull();
  });

  it('rejects non-numeric and malformed input', () => {
    for (const raw of ['abc', '1.2.3', '.', '12e5', '1 2', '--5', '½']) {
      const parsed = parseAmountToCents(raw);
      expect(parsed.cents, `expected ${raw} to be rejected`).toBeNull();
      expect(parsed.error).toBeTruthy();
    }
  });

  it('rejects amounts that are zero or below', () => {
    expect(parseAmountToCents('0').error).toBe('Enter an amount greater than zero');
    expect(parseAmountToCents('0.00').error).toBe('Enter an amount greater than zero');
    // The leading minus fails the character check before the sign check.
    expect(parseAmountToCents('-5').cents).toBeNull();
  });

  it('rejects amounts beyond the one-billion-dollar ceiling', () => {
    expect(parseAmountToCents('1000000000').cents).toBe(100_000_000_000);
    expect(parseAmountToCents('1000000001').error).toBe('That number is too large');
  });

  it('rounds to the nearest cent at two decimals', () => {
    // Guards against float error: 19.99 * 100 is 1998.9999... in IEEE-754.
    expect(parseAmountToCents('19.99').cents).toBe(1999);
    expect(parseAmountToCents('1.10').cents).toBe(110);
    expect(parseAmountToCents('4499.99').cents).toBe(449_999);
  });
});

describe('formatCents', () => {
  it('always shows two decimals', () => {
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(123_456)).toBe('$1,234.56');
    expect(formatCents(100)).toBe('$1.00');
  });
});

describe('formatCentsShort', () => {
  it('drops the decimals at and above $1,000', () => {
    // The threshold is 100_000 cents; either side of it must differ.
    expect(formatCentsShort(99_999)).toBe('$999.99');
    expect(formatCentsShort(100_000)).toBe('$1,000');
    expect(formatCentsShort(4_500_000)).toBe('$45,000');
  });

  it('collapses zero to a bare $0', () => {
    expect(formatCentsShort(0)).toBe('$0');
  });

  it('applies the threshold to magnitude, so negatives behave the same', () => {
    expect(formatCentsShort(-100_000)).toBe('-$1,000');
  });
});

describe('formatBps', () => {
  it('omits the decimal for whole percentages', () => {
    expect(formatBps(4500)).toBe('45%');
    expect(formatBps(1000)).toBe('10%');
    expect(formatBps(0)).toBe('0%');
  });

  it('shows one decimal otherwise', () => {
    expect(formatBps(1638)).toBe('16.4%');
    expect(formatBps(4701)).toBe('47.0%');
  });
});

describe('formatDriftBps', () => {
  it('signs the drift and always shows one decimal', () => {
    expect(formatDriftBps(200)).toBe('+2.0 pts');
    expect(formatDriftBps(0)).toBe('0.0 pts');
  });

  it('uses a true minus sign, not a hyphen', () => {
    // U+2212 lines up with the digits in tabular figures; a hyphen does not.
    expect(formatDriftBps(-360)).toBe('−3.6 pts');
    expect(formatDriftBps(-360)).not.toContain('-');
  });
});
