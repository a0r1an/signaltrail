/**
 * Parsed at insert by migration 003 and skip-indexed. Out-of-range client strings are NULL,
 * keeping them out of DateTime64 conversion and ordinary event-time totals.
 */
export const EVENT_TIME_SQL = 'occurred_at';

export function validateEventTimeWindow(window: { from: string; to: string }): void {
  for (const value of [window.from, window.to]) {
    if (typeof value !== 'string' || !/^(19[0-9]{2}|2[0-2][0-9]{2})-/.test(value))
      throw new RangeError('Event-time query dates must be between 1900 and 2299');
  }
}
