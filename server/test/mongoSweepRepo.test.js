import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { pendingProposalsPipeline, makeMongoSweepRepo } from '../src/policy/mongoSweepRepo.js';

/**
 * The sweep's repository, as a pure pipeline plus delegation.
 *
 * Asserted here: what "pending" means in the query, that the tenant is an
 * ObjectId (an aggregation will not cast it), that already-decided proposals
 * are filtered out before the batch is cut, and that recording an outcome goes
 * through the SAME implementation a confirmation uses -- which is what makes the
 * two race safely on one unique index. Whether MongoDB evaluates the pipeline
 * as written needs a real replica set.
 */

const TENANT = '64b7f0c2a1b2c3d4e5f60001';
const CTX = { tenantId: TENANT };
const CUTOFF = new Date('2026-09-15T11:30:00Z');
const isObjectId = (value) => value instanceof mongoose.Types.ObjectId;

const pipeline = () =>
  pendingProposalsPipeline(CTX, { olderThan: CUTOFF, limit: 100 }, { outcomes: 'actionoutcomes' });

test('pending means: resolved, older than the cutoff, in this tenant — with the tenant as an ObjectId', () => {
  const [{ $match }] = pipeline();
  assert.ok(isObjectId($match.tenantId), 'aggregate() does not cast; a string tenant would match nothing');
  assert.equal(String($match.tenantId), TENANT);
  assert.equal($match.validity, 'resolved', 'a malformed attempt was never offered, so it cannot expire');
  assert.deepEqual($match.createdAt, { $lt: CUTOFF });
});

test('oldest first, so a bounded batch always works through the backlog', () => {
  assert.deepEqual(pipeline()[1], { $sort: { createdAt: 1, _id: 1 } });
});

test('the outcome join carries the tenant condition too', () => {
  const { $lookup } = pipeline().find((stage) => stage.$lookup);
  assert.equal($lookup.from, 'actionoutcomes');
  const conditions = $lookup.pipeline[0].$match.$expr.$and;
  const tenantCondition = conditions.find((c) => c.$eq?.[0] === '$tenantId');
  assert.ok(tenantCondition && isObjectId(tenantCondition.$eq[1]));
});

test('already-decided proposals are removed BEFORE the batch is cut', () => {
  // Otherwise a batch of 100 could be 100 proposals that were confirmed long
  // ago, and the genuinely forgotten ones behind them would never be reached.
  const stages = pipeline();
  const filterAt = stages.findIndex((stage) => stage.$match?.outcomeRows);
  const limitAt = stages.findIndex((stage) => stage.$limit === 100);
  assert.deepEqual(stages[filterAt], { $match: { outcomeRows: { $size: 0 } } });
  assert.ok(filterAt < limitAt);
});

test('the join array is removed from the output', () => {
  const stages = pipeline();
  assert.deepEqual(stages[stages.length - 1], { $project: { outcomeRows: 0 } });
});

test('the pipeline cannot be built without a tenant', () => {
  assert.throws(
    () => pendingProposalsPipeline({}, { olderThan: CUTOFF, limit: 10 }, { outcomes: 'actionoutcomes' }),
    /tenant context/,
  );
});

function fakeModels() {
  const calls = [];
  return {
    calls,
    Tenant: {
      find: (filter, projection) => {
        calls.push({ op: 'Tenant.find', filter, projection });
        return { lean: async () => [{ _id: 'tenant-a' }, { _id: 'tenant-b' }] };
      },
    },
    ActionProposal: {
      aggregate: async (stages) => {
        calls.push({ op: 'ActionProposal.aggregate', stages });
        return [];
      },
    },
    ActionOutcome: { collection: { name: 'actionoutcomes' } },
  };
}

test('tenants are listed as ids only — the one unscoped read, and unscoped by nature', async () => {
  const models = fakeModels();
  const repo = makeMongoSweepRepo({ models, actionRepo: {} });
  assert.deepEqual(await repo.listTenantIds(), ['tenant-a', 'tenant-b']);
  assert.deepEqual(models.calls[0].projection, { _id: 1 });
});

test('pending proposals are fetched with the pipeline over the proposal collection', async () => {
  const models = fakeModels();
  const repo = makeMongoSweepRepo({ models, actionRepo: {} });
  await repo.findPendingProposals({ tenantId: TENANT }, { olderThan: CUTOFF, limit: 25 });

  const { stages } = models.calls.find((call) => call.op === 'ActionProposal.aggregate');
  assert.ok(stages.some((stage) => stage.$limit === 25));
});

test('decisions and outcomes go through the ACTION repository — the same code a confirmation uses', async () => {
  const delegated = [];
  const actionRepo = {
    findDecision: async (...args) => {
      delegated.push(['findDecision', ...args]);
      return { outcome: 'confirm-required' };
    },
    recordOutcome: async (...args) => {
      delegated.push(['recordOutcome', ...args]);
      return { outcome: { outcome: 'expired' }, duplicate: false };
    },
  };
  const repo = makeMongoSweepRepo({ models: fakeModels(), actionRepo });

  await repo.findDecision(CTX, 'p1', 'proposal');
  await repo.recordOutcome(CTX, { outcome: 'expired' });

  assert.deepEqual(delegated.map(([name]) => name), ['findDecision', 'recordOutcome']);
  assert.equal(delegated[0][1], CTX, 'the tenant scope is passed straight through');
});
