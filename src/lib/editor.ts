/** Turns a bps integer into an editable percent-field value, without a `%` sign. */
export function percentFieldFromBps(bps: number): string {
  return String(bps / 100);
}

export interface ParsedBps {
  bps: number | null;
  error: string | null;
}

/**
 * Parse what someone typed into a percent field, following `parseAmountToCents`'s
 * shape/spirit (see `src/lib/money.ts`) but for percents in [0, 100] mapping to
 * bps in [0, 10000].
 */
export function bpsFromPercentField(raw: string): ParsedBps {
  const trimmed = raw.trim();
  if (trimmed === '') return { bps: null, error: null };

  const cleaned = trimmed.replace(/%$/, '').trim();
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === '' || cleaned === '.') {
    return { bps: null, error: 'Enter a percentage, for example 45' };
  }

  const [, decimals = ''] = cleaned.split('.');
  if (decimals.length > 2) {
    return { bps: null, error: 'At most two decimal places' };
  }

  const bps = Math.round(Number(cleaned) * 100);
  if (bps < 0 || bps > 10_000) {
    return { bps: null, error: 'Enter a percentage between 0 and 100' };
  }

  return { bps, error: null };
}

export interface SortableItem {
  id: string;
  sortOrder: number;
}

/**
 * Returns the { id, sortOrder } pairs to PATCH to move `id` one step in
 * `direction` within `items` (already in display order). Returns an empty
 * array if the move isn't possible (already at that end of the list, or the
 * id isn't found).
 */
export function moveSortOrder(
  items: SortableItem[],
  id: string,
  direction: 'up' | 'down',
): { id: string; sortOrder: number }[] {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return [];
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= items.length) return [];

  const current = items[index];
  const target = items[targetIndex];
  return [
    { id: current.id, sortOrder: target.sortOrder },
    { id: target.id, sortOrder: current.sortOrder },
  ];
}
