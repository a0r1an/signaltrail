const DAY_MS = 24 * 60 * 60 * 1000;
// The analytics reader allows windows of at most 31 days.
const WINDOW_DAYS = [1, 7, 30];
const KINDS = ['list', 'count', 'visitors'];

/** Explorer page loads rotate through the windows an owner is likely to open. */
export function dashboardWindow(index, now = Date.now()) {
  const days = WINDOW_DAYS[index % WINDOW_DAYS.length];
  return {
    days,
    from: new Date(now - days * DAY_MS).toISOString(),
    to: new Date(now).toISOString(),
  };
}

function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return sorted.length
    ? { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) }
    : { count: 0 };
}

export function summarizeDashboard(pages) {
  const errors = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  for (const page of pages) for (const kind of KINDS) if (!page.queries[kind].ok) errors[kind]++;
  const byWindow = {};
  for (const days of WINDOW_DAYS) {
    const matching = pages.filter((page) => page.days === days).map((page) => page.ms);
    if (matching.length)
      byWindow[days] = { pages: matching.length, pageMsMax: Math.max(...matching) };
  }
  return {
    pages: pages.length,
    failedPages: pages.filter((page) => KINDS.some((kind) => !page.queries[kind].ok)).length,
    errors,
    pageMs: percentiles(pages.map((page) => page.ms)),
    byQuery: Object.fromEntries(
      KINDS.map((kind) => [
        kind,
        percentiles(
          pages.filter((page) => page.queries[kind].ok).map((page) => page.queries[kind].ms),
        ),
      ]),
    ),
    byWindow,
  };
}

export function assessDashboard(summary, { maxPageP95Ms = 2000 } = {}) {
  if (!summary.pages) return ['No dashboard page loads completed'];
  const reasons = [];
  const failed = KINDS.filter((kind) => summary.errors[kind]);
  if (failed.length)
    reasons.push(
      `Dashboard queries failed: ${failed.map((kind) => `${kind}=${summary.errors[kind]}`).join(', ')}`,
    );
  if (summary.pageMs.p95 > maxPageP95Ms)
    reasons.push(`Dashboard page p95 exceeds ${maxPageP95Ms} ms`);
  return reasons;
}
