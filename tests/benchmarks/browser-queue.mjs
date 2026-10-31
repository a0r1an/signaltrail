import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { cleanupResources } from '../load/cleanup.mjs';
import { finishRun } from '../load/run-result.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = createRequire(
  new URL('../../packages/browser-sdk/package.json', import.meta.url),
)('@playwright/test');
const html = `<!doctype html><title>SignalTrail queue benchmark</title><script type="module">
import {openEventQueue} from '/sdk.js';
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.ceil(p*sorted.length)-1];};
window.runBenchmark = async () => {
 const trials=[];
 for(const count of [100,500,1000]) for(let trial=0;trial<3;trial++) {
  const queue=await openEventQueue({projectKey:crypto.randomUUID(),ingestionUrl:location.origin+'/unused'},{maxEvents:count,maxBytes:8*1024*1024});
  try {
   const samples=[], ids=[], began=performance.now();
   for(let i=0;i<count;i++) {
    const eventId='event-'+i;
    const start=performance.now();
    const result=await queue.enqueue({schemaVersion:1,eventId,eventName:'queue_benchmark',distinctId:'benchmark',sessionId:'benchmark',sequence:i,clientTimestamp:new Date().toISOString(),url:location.href,properties:{text:'x'.repeat(128)},context:{sdkVersion:'benchmark'}});
    samples.push(performance.now()-start); ids.push(eventId);
    if(result.status!=='queued')throw new Error('Benchmark enqueue was not confirmed');
   }
   const enqueueMs=performance.now()-began;
   const readStart=performance.now(), stored=await queue.getAll(), readMs=performance.now()-readStart;
   if(stored.status!=='read'||JSON.stringify(stored.events.map(event=>event.eventId))!==JSON.stringify(ids))throw new Error('Benchmark violated FIFO persistence');
   trials.push({count,trial,storageMode:queue.storageMode,enqueueMs,readMs,p50Ms:percentile(samples,.5),p95Ms:percentile(samples,.95),p99Ms:percentile(samples,.99),first25MedianMs:percentile(samples.slice(0,25),.5),last25MedianMs:percentile(samples.slice(-25),.5),storedEvents:stored.events.length});
  }finally{queue.close();}
 }
 return trials;
};
window.ready=true;
</script>`;
const directory = resolve(
  root,
  'test-results/queue-benchmark',
  new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const result = {
  passed: false,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty:
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length >
    0,
  node: process.version,
  machine: {
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model,
    totalMemoryBytes: totalmem(),
    platform: process.platform,
    arch: process.arch,
  },
  payload: { propertyTextCharacters: 128, eventCounts: [100, 500, 1000], trialsPerCount: 3 },
  limitations: [
    'Local headless Chromium, three trials per size, no CPU throttling or concurrent tabs.',
    'Timings describe this machine and browser; no production capacity or performance budget is asserted.',
    'The queue is exercised directly without network delivery or replay recording.',
  ],
};
await writeFile(
  resolve(directory, 'report.json'),
  JSON.stringify({ ...result, incomplete: true }, null, 2),
);
const bundle = await readFile(
  new URL('../../packages/browser-sdk/.browser-harness/sdk.js', import.meta.url),
);
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (request.method !== 'GET' || !['/', '/sdk.js'].includes(path)) {
    response.writeHead(404).end();
    return;
  }
  response
    .writeHead(200, {
      'Content-Type': path === '/sdk.js' ? 'text/javascript' : 'text/html',
      'Cache-Control': 'no-store',
    })
    .end(path === '/sdk.js' ? bundle : html);
});
let browser, context, runError, timer;
try {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  browser = await chromium.launch({ headless: true });
  result.browser = browser.version();
  context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.ready === true);
  result.trials = await Promise.race([
    page.evaluate(() => window.runBenchmark()),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Queue benchmark exceeded three minutes')), 180000);
    }),
  ]);
  clearTimeout(timer);
  for (const trial of result.trials) {
    assert.equal(trial.storageMode, 'indexeddb');
    assert.equal(trial.storedEvents, trial.count);
  }
  assert.deepEqual(errors, []);
  result.passed = true;
} catch (error) {
  runError = error;
} finally {
  clearTimeout(timer);
  const completed = await finishRun({
    result,
    runError,
    cleanup: () =>
      cleanupResources([
        { name: 'close queue benchmark context', run: () => context?.close() },
        { name: 'close owned Chromium', run: () => browser?.close() },
        {
          name: 'close queue fixture',
          run: () =>
            new Promise((done, reject) => {
              server.closeAllConnections();
              server.close((error) =>
                error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : done(),
              );
            }),
        },
      ]),
    writeResult: (report) =>
      writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2)),
  });
  console.log(JSON.stringify({ directory, ...completed }, null, 2));
}
