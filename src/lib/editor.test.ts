import { describe, expect, it } from 'vitest';
import { bpsFromPercentField, moveSortOrder, percentFieldFromBps } from './editor';

describe('percentFieldFromBps', () => {
  it('formats whole numbers without decimals', () => {
    expect(percentFieldFromBps(4500)).toBe('45');
    expect(percentFieldFromBps(10000)).toBe('100');
  });

  it('formats values needing one or two decimals', () => {
    expect(percentFieldFromBps(1235)).toBe('12.35');
    expect(percentFieldFromBps(1630)).toBe('16.3');
  });

  it('formats zero', () => {
    expect(percentFieldFromBps(0)).toBe('0');
  });
});

describe('bpsFromPercentField', () => {
  it('round-trips with percentFieldFromBps for a range of values', () => {
    for (const bps of [0, 1, 25, 100, 1235, 1630, 4500, 5000, 9999, 10000]) {
      const field = percentFieldFromBps(bps);
      expect(bpsFromPercentField(field)).toEqual({ bps, error: null });
    }
  });

  it('treats an empty field as "nothing typed yet", not as an error', () => {
    expect(bpsFromPercentField('')).toEqual({ bps: null, error: null });
    expect(bpsFromPercentField('   ')).toEqual({ bps: null, error: null });
  });

  it('accepts a trailing percent sign and surrounding whitespace', () => {
    expect(bpsFromPercentField('45%')).toEqual({ bps: 4500, error: null });
    expect(bpsFromPercentField('  45 % ')).toEqual({ bps: 4500, error: null });
  });

  it('rejects more than two decimal places', () => {
    expect(bpsFromPercentField('12.345')).toEqual({
      bps: null,
      error: 'At most two decimal places',
    });
  });

  it('rejects non-numeric input', () => {
    const parsed = bpsFromPercentField('abc');
    expect(parsed.bps).toBeNull();
    expect(parsed.error).toBe('Enter a percentage, for example 45');
  });

  it('rejects negative values as out of range', () => {
    expect(bpsFromPercentField('-5')).toEqual({
      bps: null,
      error: 'Enter a percentage, for example 45',
    });
  });

  it('rejects values above 100 as out of range', () => {
    expect(bpsFromPercentField('101')).toEqual({
      bps: null,
      error: 'Enter a percentage between 0 and 100',
    });
  });

  it('accepts exactly 0 and exactly 100', () => {
    expect(bpsFromPercentField('0')).toEqual({ bps: 0, error: null });
    expect(bpsFromPercentField('100')).toEqual({ bps: 10000, error: null });
  });
});

describe('moveSortOrder', () => {
  const items = [
    { id: 'a', sortOrder: 1 },
    { id: 'b', sortOrder: 2 },
    { id: 'c', sortOrder: 3 },
  ];

  it('moves a middle item up, swapping sortOrder with the item above', () => {
    expect(moveSortOrder(items, 'b', 'up')).toEqual([
      { id: 'b', sortOrder: 1 },
      { id: 'a', sortOrder: 2 },
    ]);
  });

  it('moves a middle item down, swapping sortOrder with the item below', () => {
    expect(moveSortOrder(items, 'b', 'down')).toEqual([
      { id: 'b', sortOrder: 3 },
      { id: 'c', sortOrder: 2 },
    ]);
  });

  it('returns an empty array when moving the first item up', () => {
    expect(moveSortOrder(items, 'a', 'up')).toEqual([]);
  });

  it('returns an empty array when moving the last item down', () => {
    expect(moveSortOrder(items, 'c', 'down')).toEqual([]);
  });

  it('returns an empty array for a single-item list in either direction', () => {
    const single = [{ id: 'only', sortOrder: 5 }];
    expect(moveSortOrder(single, 'only', 'up')).toEqual([]);
    expect(moveSortOrder(single, 'only', 'down')).toEqual([]);
  });

  it('returns an empty array when the id is not found', () => {
    expect(moveSortOrder(items, 'missing', 'up')).toEqual([]);
  });
});
