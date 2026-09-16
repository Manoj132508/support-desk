import test from 'node:test';
import assert from 'node:assert/strict';
import { readPlan } from '../perf/queryPlans.js';

/**
 * The query plan check reads MongoDB's explain output. If it misread a plan it
 * would pass a collection scan as fine, so its reading is tested against the
 * shapes explain actually returns.
 */

const indexedFind = {
  queryPlanner: {
    winningPlan: {
      stage: 'LIMIT',
      inputStage: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'tenantId_1_conversationId_1_createdAt_1' } },
    },
  },
  executionStats: { nReturned: 6, totalKeysExamined: 6, totalDocsExamined: 6 },
};

test('an index scan that reads only what it returns has no concerns', () => {
  const plan = readPlan(indexedFind);
  assert.deepEqual(plan.indexes, ['tenantId_1_conversationId_1_createdAt_1']);
  assert.equal(plan.docs, 6);
  assert.deepEqual(plan.concerns, []);
});

test('plans the optimiser rejected are not reported as what ran', () => {
  const plan = readPlan({
    queryPlanner: {
      winningPlan: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'tenantId_1_createdAt_-1__id_-1' } },
      rejectedPlans: [{ stage: 'SORT', inputStage: { stage: 'COLLSCAN' } }, { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'tenantId_1' } }],
    },
    executionStats: {
      nReturned: 4,
      totalKeysExamined: 4,
      totalDocsExamined: 4,
      allPlansExecution: [{ executionStages: { stage: 'SORT' } }],
    },
  });
  assert.deepEqual(plan.indexes, ['tenantId_1_createdAt_-1__id_-1']);
  assert.deepEqual(plan.concerns, []);
});

test('a collection scan is reported', () => {
  const plan = readPlan({
    queryPlanner: { winningPlan: { stage: 'COLLSCAN' } },
    executionStats: { nReturned: 1, totalKeysExamined: 0, totalDocsExamined: 1 },
  });
  assert.ok(plan.concerns.includes('collection scan'));
});

test('a sort the index could not provide is reported, even when the index chose the rows', () => {
  const plan = readPlan({
    queryPlanner: {
      winningPlan: { stage: 'SORT', inputStage: { stage: 'FETCH', inputStage: { stage: 'IXSCAN', indexName: 'tenantId_1_active_1_openedAt_1' } } },
    },
    executionStats: { nReturned: 0, totalKeysExamined: 0, totalDocsExamined: 0 },
  });
  assert.ok(plan.concerns.includes('sort in memory'));
});

test('reading more documents than are returned is reported with the numbers', () => {
  const plan = readPlan({
    queryPlanner: { winningPlan: { stage: 'FETCH', filter: {}, inputStage: { stage: 'IXSCAN', indexName: 'actionType_1_active_1_priority_1' } } },
    executionStats: { nReturned: 5, totalKeysExamined: 605, totalDocsExamined: 605 },
  });
  assert.ok(plan.concerns.includes('examined 605 documents to return 5'));
});

test('an aggregate’s $lookup that scans its collection is reported', () => {
  const plan = readPlan({
    stages: [
      { $cursor: { queryPlanner: { winningPlan: { stage: 'IXSCAN', indexName: 'tenantId_1_createdAt_-1__id_-1' } } }, nReturned: 25, totalKeysExamined: 25, totalDocsExamined: 25 },
      { $lookup: { from: 'actionoutcomes' }, collectionScans: 25, indexesUsed: [] },
    ],
  });
  assert.equal(plan.keys, 25);
  assert.ok(plan.concerns.includes('$lookup into actionoutcomes scans the collection'));
});
