import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyIndexes, indexDrift, missingIndexProblems } from '../src/db/indexes.js';
import { connectionOptions } from '../src/db/connect.js';

/**
 * Phase 15: indexes as a deploy step. Checked against a real replica set as the
 * phase was built; these pin the decisions without one.
 */

function model(name, { toCreate = [], toDrop = [] } = {}) {
  const calls = [];
  return {
    modelName: name,
    calls,
    diffIndexes: async () => ({ toCreate, toDrop }),
    syncIndexes: async () => {
      calls.push('syncIndexes');
      return toDrop;
    },
  };
}

test('drift lists missing and extra indexes by model, and leaves out models that match', async () => {
  const drift = await indexDrift({
    models: [
      model('ActionOutcome', { toCreate: [{ idempotencyKey: 1 }] }),
      model('Tenant'),
      model('Ticket', { toDrop: ['tenantId_1_active_1_openedAt_1'] }),
    ],
  });
  assert.deepEqual(drift, [
    { model: 'ActionOutcome', missing: ['idempotencyKey:1'], extra: [] },
    { model: 'Ticket', missing: [], extra: ['tenantId_1_active_1_openedAt_1'] },
  ]);
});

test('only a MISSING index stops the API; an extra one does not', () => {
  const problems = missingIndexProblems([
    { model: 'ActionOutcome', missing: ['idempotencyKey:1', 'proposalId:1'], extra: [] },
    { model: 'Ticket', missing: [], extra: ['tenantId_1_active_1_openedAt_1'] },
  ]);
  assert.deepEqual(problems, ['ActionOutcome is missing 2 index(es): idempotencyKey:1 | proposalId:1']);
});

test('applying reports what it created and dropped', async () => {
  const ticket = model('Ticket', { toCreate: [{ tenantId: 1, active: 1, openedAt: 1, _id: 1 }], toDrop: ['tenantId_1_active_1_openedAt_1'] });
  const changes = await applyIndexes({ models: [ticket, model('Tenant')] });
  assert.deepEqual(changes, [
    { model: 'Ticket', created: ['tenantId:1, active:1, openedAt:1, _id:1'], dropped: ['tenantId_1_active_1_openedAt_1'] },
  ]);
  assert.deepEqual(ticket.calls, ['syncIndexes']);
});

test('production never builds indexes automatically; development still does', () => {
  assert.equal(connectionOptions({ isProduction: true }).autoIndex, false);
  assert.equal(connectionOptions({ isProduction: false }).autoIndex, true);
  // The guarantees that were already there stay.
  assert.deepEqual(connectionOptions({ isProduction: true }).writeConcern, { w: 'majority' });
});

test('in production the API checks indexes after connecting and before listening', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const connected = source.indexOf('await connectDatabase()');
  const checked = source.indexOf('missingIndexProblems(drift)');
  const listening = source.indexOf('app.listen(');
  assert.ok(connected > -1 && checked > connected && listening > checked);
  assert.match(source, /if \(config\.isProduction\) \{\s*const drift = await indexDrift\(\);/);
});
