import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, call } from './helpers.js';

test('FR-14.1: health reports each dependency independently', async () => {
  await withServer(async (base) => {
    const { status, body } = await call(base, '/api/health');
    assert.equal(status, 200);
    for (const key of ['api', 'database', 'aiService']) {
      assert.ok(key in body, `health is missing ${key}`);
    }
  });
});

test('FR-14.3: a degraded dependency does not make the API unhealthy', async () => {
  // Returning 503 here would take a healthy instance out of a load balancer
  // and turn a partial outage into a total one. The desk still serves tickets,
  // history and the console when the AI service is down.
  await withServer(async (base) => {
    const { status, body } = await call(base, '/api/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'degraded');
    assert.equal(body.api, 'ok');
  });
});

test('unconfigured and unreachable are distinguished', async () => {
  await withServer(async (base) => {
    const { body } = await call(base, '/api/health');
    // With no MONGODB_URI set, the honest answer is "you have not configured
    // this", not "it is refusing connections" -- different problems, different
    // fixes, and collapsing them wastes the first ten minutes of an incident.
    assert.equal(body.database, 'unconfigured');
  });
});
