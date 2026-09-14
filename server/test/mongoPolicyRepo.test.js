import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMongoPolicyRepo, deactivateUpdate } from '../src/policy/mongoPolicyRepo.js';
import { RuleConflictError } from '../src/policy/policyAdmin.js';

/**
 * The policy repository, with a fake PolicyRule model.
 *
 * Asserted here: which scope each query uses, that a version change and the
 * old version's retirement share one session, that the only update ever made
 * to an existing rule touches `active` and nothing else, and how a duplicate
 * key is translated. NOT asserted, because it needs a replica set: that MongoDB
 * really commits the two writes together and enforces the unique index.
 */

const CTX = { tenantId: 't1' };
const VALID_ID = '64b7f0c2a1b2c3d4e5f60718';

function chain(value, log, label) {
  const query = {
    sort(spec) {
      log.push({ op: `${label}.sort`, spec });
      return query;
    },
    lean() {
      return Promise.resolve(value);
    },
  };
  return query;
}

function fakeModels({ createError = null } = {}) {
  const log = [];
  return {
    log,
    PolicyRule: {
      find: (filter) => {
        log.push({ op: 'find', filter });
        return chain([], log, 'find');
      },
      findOne: (filter) => {
        log.push({ op: 'findOne', filter });
        return chain({ _id: VALID_ID }, log, 'findOne');
      },
      updateMany: async (filter, update, options) => {
        log.push({ op: 'updateMany', filter, update, options });
        return { modifiedCount: 1 };
      },
      create: async (docs, options) => {
        log.push({ op: 'create', docs, options });
        if (createError) throw createError;
        return docs.map((doc) => ({ ...doc, toObject: () => ({ _id: 'new-version', ...doc }) }));
      },
    },
  };
}

function fakeSession() {
  const session = {
    ended: false,
    async withTransaction(fn) {
      await fn();
    },
    async endSession() {
      session.ended = true;
    },
  };
  return session;
}

function setup(options) {
  const models = fakeModels(options);
  const session = fakeSession();
  const repo = makeMongoPolicyRepo({ models, startSession: async () => session });
  const ops = (name) => models.log.filter((entry) => entry.op === name);
  return { repo, session, ops };
}

const duplicateKey = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

const next = {
  tenantId: 't1',
  ruleKey: 'TENANT-HIGH-VALUE',
  actionType: 'order.cancel',
  version: 2,
  active: true,
  priority: 200,
  conditions: [],
  outcome: 'refuse',
  customerMessage: 'A colleague will review this.',
  internalReason: 'High value.',
  createdBy: 'admin-1',
};

test('ADR 0008: listing reads tenant rules plus the baseline', async () => {
  const { repo, ops } = setup();
  await repo.listRules(CTX);
  assert.deepEqual(ops('find')[0].filter, { tenantId: { $in: ['t1', null] } });
});

test('a rule is found by id within tenant-plus-baseline, so a baseline rule can be refused honestly', async () => {
  const { repo, ops } = setup();
  await repo.findRuleById(CTX, VALID_ID);
  assert.deepEqual(ops('findOne')[0].filter, { _id: VALID_ID, tenantId: { $in: ['t1', null] } });
});

test('INV-D: a malformed id is "not found" without a query', async () => {
  const { repo, ops } = setup();
  assert.equal(await repo.findRuleById(CTX, 'not-an-id'), null);
  assert.equal(ops('findOne').length, 0);
});

test('the latest version is looked up in the TENANT only, newest first', async () => {
  // Not policy scope: a baseline rule that happened to share the key must never
  // be mistaken for the tenant's latest version.
  const { repo, ops } = setup();
  await repo.findLatestVersion(CTX, 'TENANT-HIGH-VALUE');
  assert.deepEqual(ops('findOne')[0].filter, { ruleKey: 'TENANT-HIGH-VALUE', tenantId: 't1' });
  assert.deepEqual(ops('findOne.sort')[0].spec, { version: -1 });
});

test('a new version and the retirement of the old one share ONE session', async () => {
  // Outside a transaction there would be a moment with two active versions of
  // the same rule, or none -- and the engine evaluates whatever is active.
  const { repo, ops, session } = setup();
  const inserted = await repo.insertVersion(CTX, { next });

  const [update] = ops('updateMany');
  const [create] = ops('create');
  assert.equal(update.options.session, session);
  assert.equal(create.options.session, session);
  assert.deepEqual(update.filter, { ruleKey: 'TENANT-HIGH-VALUE', active: true, tenantId: 't1' });
  assert.equal(create.docs[0].tenantId, 't1');
  assert.equal(inserted._id, 'new-version');
  assert.equal(session.ended, true);
});

test('PHASE 3 §5.3: the only change ever made to an existing version is its active flag', async () => {
  const { repo, ops } = setup();
  await repo.insertVersion(CTX, { next });
  assert.deepEqual(ops('updateMany')[0].update, { $set: { active: false } });
  assert.deepEqual(Object.keys(deactivateUpdate().$set), ['active']);
});

test('the deactivation update is a fresh object each time, never a shared one Mongoose could mutate', () => {
  assert.notEqual(deactivateUpdate(), deactivateUpdate());
});

test('two editors writing the same next version: the loser gets a RuleConflictError', async () => {
  const { repo, session } = setup({ createError: duplicateKey() });
  await assert.rejects(repo.insertVersion(CTX, { next }), (error) => error instanceof RuleConflictError);
  assert.equal(session.ended, true);
});

test('any other failure propagates unchanged, and the session still ends', async () => {
  const { repo, session } = setup({ createError: new Error('not primary') });
  await assert.rejects(repo.insertVersion(CTX, { next }), /not primary/);
  assert.equal(session.ended, true);
});

test('creating a rule carries the tenant, and a taken key is a RuleConflictError', async () => {
  const created = setup();
  const rule = await created.repo.insertRule(CTX, { ...next, version: 1 });
  assert.equal(created.ops('create')[0].docs[0].tenantId, 't1');
  assert.equal(rule._id, 'new-version');

  const taken = setup({ createError: duplicateKey() });
  await assert.rejects(taken.repo.insertRule(CTX, { ...next, version: 1 }), (error) => error instanceof RuleConflictError);
});
