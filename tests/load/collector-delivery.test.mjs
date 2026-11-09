import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCollectorDelivery } from './collector-delivery.mjs';

test('collector evidence isolates load forwarding and excludes endpoint/credential labels', () => {
  const evidence = parseCollectorDelivery(
    'prometheus_forwarded_samples_total{component_id="prometheus.scrape.load"} 123\nprometheus_forwarded_samples_total{component_id="prometheus.scrape.ingestion"} 999\nprometheus_remote_storage_samples_total{url="https://private.invalid",remote_name="x"} 456\n',
  );
  assert.equal(evidence.loadForwarded, 123);
  assert.equal(evidence.remoteWritten, 456);
  assert.doesNotMatch(JSON.stringify(evidence), /private.invalid|url|remote_name/);
});
