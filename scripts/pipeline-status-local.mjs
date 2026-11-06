import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnalyticsReader } from '../packages/analytics/dist/index.js';
try {
  if (process.argv.length !== 2) throw new Error();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const state = JSON.parse(
    await readFile(join(root, '.local-data/dashboard-local-setup.json'), 'utf8'),
  );
  const reader = createAnalyticsReader({
    endpoint: 'http://127.0.0.1:8123',
    username: state.readerName,
    password: state.chPassword,
  });
  const now = Date.now(),
    window = {
      projectId: state.projectId,
      from: new Date(now - 86400000).toISOString(),
      to: new Date(now + 1000).toISOString(),
    };
  const productViews = await reader.countOccurredEvents({
    ...window,
    eventName: 'demo_product_viewed',
  });
  const probes = await reader.countOccurredEvents({ ...window, eventName: 'local_pipeline_probe' });
  console.log(
    JSON.stringify(
      {
        target: 'local-compose',
        window: 'last 24 hours',
        productViews,
        commandLineProbes: probes,
        browserAutomationVerified: false,
      },
      null,
      2,
    ),
  );
} catch {
  console.error(
    'Local pipeline storage status unavailable; no changes made and no credentials printed.',
  );
  process.exitCode = 1;
}
