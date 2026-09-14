import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { buildAttemptPipeline, makeMongoAuditRepo } from '../src/policy/mongoAuditRepo.js';
import { kindOf } from '../src/policy/auditQuery.js';

/**
 * The audit aggregation, as a pure pipeline.
 *
 * What can be asserted without a database is the pipeline's structure, and the
 * structure is where the risks are: ids that an aggregation will not cast for
 * you, a tenant condition that must hold inside the joins as well as outside
 * them, and a keyset bound that must break ties. Whether MongoDB evaluates the
 * `$switch` exactly as kindOf() does is a real-database question, and the Phase
 * 10 document lists it as unverified.
 */

const TENANT = '64b7f0c2a1b2c3d4e5f60001';
const CUSTOMER = '64b7f0c2a1b2c3d4e5f60002';
const LAST_ID = '64b7f0c2a1b2c3d4e5f60003';
const CTX = { tenantId: TENANT };
const NAMES = { outcomes: 'actionoutcomes', decisions: 'policydecisions' };
const isObjectId = (value) => value instanceof mongoose.Types.ObjectId;

const pipeline = (filters = {}) => buildAttemptPipeline(CTX, { limit: 51, ...filters }, NAMES);
const stageOf = (stages, name) => stages.filter((stage) => name in stage);

test('THE TENANT IS AN ObjectId, because an aggregation does not cast', () => {
  // find() quietly converts a string; aggregate() does not. A string here would
  // match nothing -- an empty audit, and a baffling one.
  const [first] = pipeline();
  assert.ok(first.$match, 'the tenant match must be the very first stage');
  assert.ok(isObjectId(first.$match.tenantId));
  assert.equal(String(first.$match.tenantId), TENANT);
});

test('filters are applied, with ids cast and the date range bounded', () => {
  const from = new Date('2026-09-01T00:00:00Z');
  const to = new Date('2026-09-14T23:59:59Z');
  const [{ $match }] = pipeline({ actionType: 'order.cancel', customerId: CUSTOMER, from, to });

  assert.equal($match.actionType, 'order.cancel');
  assert.ok(isObjectId($match.customerId));
  assert.deepEqual($match.createdAt, { $gte: from, $lte: to });
});

test('the keyset bound breaks ties on _id, so attempts in the same millisecond are not lost', () => {
  const createdAt = new Date('2026-09-14T12:00:00Z');
  const [{ $match }] = pipeline({ before: { createdAt, id: LAST_ID } });

  assert.deepEqual($match.$or[0], { createdAt: { $lt: createdAt } });
  assert.deepEqual($match.$or[1].createdAt, createdAt);
  assert.ok(isObjectId($match.$or[1]._id.$lt));
});

test('newest first, with _id as the tiebreak the cursor relies on', () => {
  assert.deepEqual(pipeline()[1], { $sort: { createdAt: -1, _id: -1 } });
});

test('with no kind filter, the page is cut BEFORE the joins', () => {
  const stages = pipeline();
  assert.deepEqual(stages[2], { $limit: 51 });
  assert.ok(stages.findIndex((stage) => stage.$limit) < stages.findIndex((stage) => stage.$lookup));
});

test('with a kind filter, the page is cut AFTER it, since kind depends on the join', () => {
  const stages = pipeline({ kinds: ['malformed', 'refused_at_proposal'] });
  const firstLookup = stages.findIndex((stage) => stage.$lookup);
  const limits = stages.map((stage, index) => (stage.$limit ? index : -1)).filter((index) => index >= 0);

  assert.equal(limits.length, 1);
  assert.ok(limits[0] > firstLookup);
  assert.deepEqual(stages[limits[0] - 1], { $match: { kind: { $in: ['malformed', 'refused_at_proposal'] } } });
});

test('BOTH JOINS carry the tenant condition too — defence in depth', () => {
  // A broken invariant elsewhere must yield a missing join, never another
  // tenant's decision attached to this tenant's attempt.
  const lookups = stageOf(pipeline(), '$lookup');
  assert.equal(lookups.length, 2);

  for (const { $lookup } of lookups) {
    const conditions = $lookup.pipeline[0].$match.$expr.$and;
    const tenantCondition = conditions.find((c) => c.$eq?.[0] === '$tenantId');
    assert.ok(tenantCondition, `${$lookup.from} join is missing its tenant condition`);
    assert.ok(isObjectId(tenantCondition.$eq[1]));
  }
});

test('the decision join takes only the PROPOSAL-stage decision', () => {
  const decisions = stageOf(pipeline(), '$lookup').find(({ $lookup }) => $lookup.from === 'policydecisions');
  const conditions = decisions.$lookup.pipeline[0].$match.$expr.$and;
  assert.ok(conditions.some((c) => c.$eq?.[0] === '$stage' && c.$eq?.[1] === 'proposal'));
});

test('the kind derivation checks malformed FIRST, as kindOf does', () => {
  // Order matters: an attempt is labelled malformed whatever else is attached
  // to it. The $switch and kindOf() are written to mirror each other.
  const { branches, default: fallback } = stageOf(pipeline(), '$set').find((stage) => stage.$set.kind).$set.kind.$switch;

  assert.deepEqual(branches[0], { case: { $eq: ['$validity', 'malformed'] }, then: 'malformed' });
  assert.equal(branches[1].then, '$outcome.outcome');
  assert.equal(fallback, 'pending');

  assert.equal(kindOf({ validity: 'malformed', outcome: { outcome: 'executed' } }), 'malformed');
  assert.equal(kindOf({ validity: 'resolved', outcome: { outcome: 'executed' } }), 'executed');
  assert.equal(kindOf({ validity: 'resolved' }), 'pending');
});

test('the join arrays are removed from the output', () => {
  const stages = pipeline();
  assert.deepEqual(stages[stages.length - 1], { $project: { outcomeRows: 0, decisionRows: 0 } });
});

test('the pipeline cannot be built without a tenant', () => {
  assert.throws(() => buildAttemptPipeline({}, { limit: 10 }, NAMES), /tenant context/);
});

test('the repo aggregates over proposals, joining the models’ own collection names', async () => {
  let received = null;
  const models = {
    ActionProposal: {
      aggregate: async (stages) => {
        received = stages;
        return [];
      },
    },
    ActionOutcome: { collection: { name: 'actionoutcomes' } },
    PolicyDecision: { collection: { name: 'policydecisions' } },
  };

  const rows = await makeMongoAuditRepo({ models }).findAttempts(CTX, { limit: 11 });
  assert.deepEqual(rows, []);
  const froms = stageOf(received, '$lookup').map(({ $lookup }) => $lookup.from);
  assert.deepEqual(froms, ['actionoutcomes', 'policydecisions']);
});

test('an index serves the audit sort, with its keys in the order the pipeline uses them', async () => {
  const { ActionProposal } = await import('../src/db/models/index.js');
  const index = ActionProposal.schema
    .indexes()
    .find(([fields]) => fields.tenantId === 1 && fields.createdAt === -1 && fields._id === -1);

  assert.ok(index, 'expected an index on { tenantId: 1, createdAt: -1, _id: -1 }');
  // Key order is what makes an index usable for a sort: it must lead with the
  // tenant the pipeline matches on, then follow the $sort exactly.
  assert.deepEqual(Object.keys(index[0]), ['tenantId', 'createdAt', '_id']);
  assert.deepEqual(pipeline()[1].$sort, { createdAt: -1, _id: -1 });
});
