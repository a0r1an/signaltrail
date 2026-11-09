export function missingDashboardMetrics(dashboard, bodies) {
  const exposed = new Set(
    bodies.flatMap((body) =>
      [...body.matchAll(/^([a-zA-Z_:][a-zA-Z0-9_:]*)[ {]/gm)].map((match) => match[1]),
    ),
  );
  const referenced = new Set(
    dashboard.panels.flatMap((panel) =>
      (panel.targets ?? []).flatMap((target) =>
        [...target.expr.matchAll(/\bsignaltrail_[a-zA-Z0-9_]+/g)].map((match) => match[0]),
      ),
    ),
  );
  return [...referenced].filter((name) => !exposed.has(name)).sort();
}
