/** Keep out-of-range legacy strings out of DateTime64 conversion and ordinary event-time totals. */
export const EVENT_TIME_SQL = `if(match(client_timestamp, '^(19[0-9]{2}|2[0-2][0-9]{2})-'), parseDateTime64BestEffortOrNull(client_timestamp, 3, 'UTC'), NULL)`;

export function validateEventTimeWindow(window: { from: string; to: string }): void {
  for (const value of [window.from, window.to]) {
    if (typeof value !== 'string' || !/^(19[0-9]{2}|2[0-2][0-9]{2})-/.test(value))
      throw new RangeError('Event-time query dates must be between 1900 and 2299');
  }
}
