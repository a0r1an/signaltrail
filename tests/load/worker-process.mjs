import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Own only this child; never signal an existing development worker.
export function startWorkerProcess({ groupId, topic, deadLetterTopic }) {
  const child = spawn(process.execPath, ['workers/event-processor/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      SIGNALTRAIL_REDPANDA_BROKERS: '127.0.0.1:29092',
      SIGNALTRAIL_REDPANDA_TOPIC: topic,
      SIGNALTRAIL_REDPANDA_DLQ_TOPIC: deadLetterTopic,
      SIGNALTRAIL_PROCESSOR_GROUP_ID: groupId,
      SIGNALTRAIL_CLICKHOUSE_URL: 'http://127.0.0.1:38123',
      SIGNALTRAIL_CLICKHOUSE_USERNAME: 'signaltrail',
      SIGNALTRAIL_CLICKHOUSE_PASSWORD: 'signaltrail_local',
      SIGNALTRAIL_CLICKHOUSE_TIMEOUT_MS: '250',
    },
  });
  let output = '';
  let settled = false;
  let result;
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  function collect(data) {
    output = (output + data.toString()).slice(-16384);
  }
  const exited = new Promise((resolve) => {
    child.once('error', () => {
      settled = true;
      result = { error: true };
      resolve(result);
    });
    child.once('exit', (code, signal) => {
      settled = true;
      result = { code, signal };
      resolve(result);
    });
  });
  return {
    async waitFor(marker, timeoutMs = 75000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (output.includes(marker)) return;
        if (settled) throw new Error('Owned worker exited before expected lifecycle marker');
        await delay(50);
      }
      throw new Error('Owned worker lifecycle marker deadline exceeded');
    },
    async stop(signal = 'SIGTERM') {
      if (!settled) child.kill(signal);
      const deadline = Date.now() + 20000;
      while (!settled && Date.now() < deadline) await delay(50);
      if (!settled) {
        child.kill('SIGKILL');
        await Promise.race([exited, delay(2000)]);
        throw new Error('Owned worker failed to stop before deadline');
      }
      return result;
    },
  };
}
