import assert from 'node:assert/strict';
import { createDashboardAnalyticsHandler } from '../../apps/dashboard/src/features/analytics/handler.ts';

/** Fixture verifier only; production service binds Clerk's resource-level owner guard. */
export async function exerciseDashboardReads({
  reader,
  database,
  sql,
  projectA,
  projectB,
  userA,
  orgA,
}) {
  let reads = 0;
  const handler = createDashboardAnalyticsHandler({
    readOwnerAccess: async () => ({
      status: 'authorized',
      principal: { issuer: 'issuer-a', subject: 'same-subject' },
      sessionId: 'fixture-only',
    }),
    query: database.query,
    reader: {
      countReceivedEvents: reader.countReceivedEvents,
      countOccurredEvents: async (...args) => {
        reads++;
        return reader.countOccurredEvents(...args);
      },
      countOccurredVisitors: async (...args) => {
        reads++;
        return reader.countOccurredVisitors(...args);
      },
      listOccurredEvents: async (...args) => {
        reads++;
        return reader.listOccurredEvents(...args);
      },
    },
  });
  const target = (project, operation = 'count') =>
    new Request(
      `https://dashboard.invalid/api/analytics/occurred/${operation}?projectId=${project}&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z`,
    );
  assert.equal((await handler(target(projectB))).status, 403);
  assert.equal(reads, 0);
  const allowed = await handler(target(projectA));
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { count: '1' });
  const page = await handler(target(projectA, 'events'));
  assert.equal(page.status, 200);
  const body = await page.json();
  assert.equal(body.events[0].occurredAt, '2026-11-01T12:00:00.000Z');
  assert.equal(body.events[0].eventId, 'event-a');
  assert.deepEqual(await (await handler(target(projectA, 'visitors/count'))).json(), {
    count: '1',
  });
  const before = reads;
  try {
    await sql(
      `DELETE FROM signaltrail_control.organization_memberships WHERE organization_id='${orgA}' AND principal_id='${userA}'`,
    );
    assert.equal((await handler(target(projectA))).status, 403);
    assert.equal(reads, before);
  } finally {
    await sql(
      `INSERT INTO signaltrail_control.organization_memberships(organization_id,principal_id,role) VALUES ('${orgA}','${userA}','owner') ON CONFLICT DO NOTHING`,
    );
  }
  return {
    passed: true,
    realMembershipAndOccurrenceReads: true,
    crossOrganizationDeniedBeforeReads: true,
    revocationRechecked: true,
    limitation:
      'Fixture verifier; real Clerk login and provisioned owner membership remain unverified.',
  };
}
