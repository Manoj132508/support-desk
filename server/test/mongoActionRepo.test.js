import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMongoActionRepo, conditionalCancelFilter } from '../src/policy/mongoActionRepo.js';
import { ConcurrentModificationError } from '../src/policy/actionService.js';

/**
 * The Mongo repo, with fake models.
 *
 * What is asserted here is the SHAPE of every query and the translation of
 * database outcomes -- the parts that carry security weight. What cannot be
 * asserted without a real replica set is that MongoDB itself enforces the unique
 * index and the transaction; that is listed as unverified in the Phase 10
 * document, not implied by these tests.
 */

const CTX = { tenantId: 't1' };
const ORDER = { _id: 'o1', __v: 0, status: 'paid', totalMinor: 12_900, currency: 'GBP', orderNumber: '1043' };
const AT = new Date('2026-09-14T12:00:00Z');
const OUTCOME = {
  proposalId: 'p1',
  outcome: 'executed',
  idempotencyKey: 'proposal:p1',
  confirmation: { userId: 'u1', at: AT, confirmedText: 'Cancel order 1043' },
};

function chain(value, log, label) {
  const query = {
    session(session) {
      log.push({ op: `${label}.session`, session });
      return query;
    },
    lean() {
      return Promise.resolve(value);
    },
  };
  return query;
}

function fakeModels({ updatedOrder = { _id: 'o1', __v: 1 }, outcomeLookups = [], createError = null } = {}) {
  const log = [];
  const toDoc = (data) => ({ ...data, toObject: () => ({ ...data }) });
  return {
    log,
    Order: {
      countDocuments: async (filter) => {
        log.push({ op: 'Order.countDocuments', filter });
        return 2;
      },
      findOne: (filter) => {
        log.push({ op: 'Order.findOne', filter });
        return chain(null, log, 'Order.findOne');
      },
      findOneAndUpdate: (filter, update, options) => {
        log.push({ op: 'Order.findOneAndUpdate', filter, update, options });
        return chain(updatedOrder, log, 'Order.findOneAndUpdate');
      },
    },
    PolicyRule: {
      find: (filter) => {
        log.push({ op: 'PolicyRule.find', filter });
        return chain([], log, 'PolicyRule.find');
      },
    },
    ActionProposal: {
      create: async (docs) => {
        log.push({ op: 'ActionProposal.create', docs });
        return docs.map((doc) => toDoc({ _id: 'p1', ...doc }));
      },
      findOne: (filter) => {
        log.push({ op: 'ActionProposal.findOne', filter });
        return chain(null, log, 'ActionProposal.findOne');
      },
    },
    PolicyDecision: {
      create: async (docs) => {
        log.push({ op: 'PolicyDecision.create', docs });
        return docs.map(toDoc);
      },
      findOne: (filter) => {
        log.push({ op: 'PolicyDecision.findOne', filter });
        return chain(filter.stage === 'proposal' ? { decision: { outcome: 'confirm-required' } } : null, log, 'PolicyDecision.findOne');
      },
    },
    ActionOutcome: {
      create: async (docs, options) => {
        log.push({ op: 'ActionOutcome.create', docs, options });
        if (createError) throw createError;
        return docs.map((doc) => toDoc({ _id: 'out1', ...doc }));
      },
      findOne: (filter) => {
        log.push({ op: 'ActionOutcome.findOne', filter });
        return chain(outcomeLookups.length ? outcomeLookups.shift() : null, log, 'ActionOutcome.findOne');
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
  const repo = makeMongoActionRepo({ models, startSession: async () => session });
  const ops = (name) => models.log.filter((entry) => entry.op === name);
  return { repo, models, session, ops };
}

/* ── The conditional write ────────────────────────────────────────────── */

test('the cancellation is conditional on the FACTS the decision read, not just the version', () => {
  // A version-only guard misses another writer's plain updateOne -- a shipping
  // integration marking the order dispatched without touching __v -- and would
  // then cancel a shipped order.
  assert.deepEqual(conditionalCancelFilter(CTX, ORDER), {
    _id: 'o1',
    __v: 0,
    status: 'paid',
    totalMinor: 12_900,
    currency: 'GBP',
    tenantId: 't1',
  });
});

test('the conditional write cannot be built without a tenant', () => {
  assert.throws(() => conditionalCancelFilter({}, ORDER), /tenant context/);
});

/* ── Tenancy in every query ───────────────────────────────────────────── */

test('ADR 0008: rules are loaded as tenant plus baseline, active only', async () => {
  const { repo, ops } = setup();
  await repo.loadRules(CTX, 'order.cancel');
  assert.deepEqual(ops('PolicyRule.find')[0].filter, {
    actionType: 'order.cancel',
    active: true,
    tenantId: { $in: ['t1', null] },
  });
});

test('ADR 0005: an order is found only within this tenant AND this customer', async () => {
  const { repo, ops } = setup();
  await repo.findCustomerOrder(CTX, 'c1', '1043');
  await repo.findOrderById(CTX, 'c1', 'o1');
  assert.deepEqual(ops('Order.findOne')[0].filter, { customerId: 'c1', orderNumber: '1043', tenantId: 't1' });
  assert.deepEqual(ops('Order.findOne')[1].filter, { _id: 'o1', customerId: 'c1', tenantId: 't1' });
});

test('the recent-order count is scoped to the tenant and the customer', async () => {
  const { repo, ops } = setup();
  const since = new Date('2026-06-16T12:00:00Z');
  assert.equal(await repo.countRecentOrders(CTX, 'c1', since), 2);
  assert.deepEqual(ops('Order.countDocuments')[0].filter, {
    customerId: 'c1',
    placedAt: { $gte: since },
    tenantId: 't1',
  });
});

test('INV-D: a malformed proposal id is "not found" WITHOUT a query, so a CastError cannot leak existence', async () => {
  const { repo, ops } = setup();
  assert.equal(await repo.findProposal(CTX, 'c1', 'not-an-object-id'), null);
  assert.equal(ops('ActionProposal.findOne').length, 0);
});

test('a well-formed proposal id is looked up within tenant and customer', async () => {
  const { repo, ops } = setup();
  await repo.findProposal(CTX, 'c1', '64b7f0c2a1b2c3d4e5f60718');
  assert.deepEqual(ops('ActionProposal.findOne')[0].filter, {
    _id: '64b7f0c2a1b2c3d4e5f60718',
    customerId: 'c1',
    tenantId: 't1',
  });
});

test('a recorded proposal and decision always carry the tenant', async () => {
  const { repo, ops } = setup();
  const proposal = await repo.recordProposal(CTX, { validity: 'malformed', problemCodes: ['not_an_object'] });
  await repo.recordDecision(CTX, { proposalId: 'p1', stage: 'proposal' });

  assert.equal(ops('ActionProposal.create')[0].docs[0].tenantId, 't1');
  assert.equal(ops('PolicyDecision.create')[0].docs[0].tenantId, 't1');
  assert.equal(typeof proposal.toObject, 'undefined', 'the service receives a plain object, not a document');
});

test('the recorded proposal-time decision is returned as stored', async () => {
  const { repo } = setup();
  assert.deepEqual(await repo.findDecision(CTX, 'p1', 'proposal'), { outcome: 'confirm-required' });
  assert.equal(await repo.findDecision(CTX, 'p1', 'execution'), null);
});

/* ── Once-only outcomes ───────────────────────────────────────────────── */

const duplicateKeyError = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

test('a new outcome is inserted with the tenant', async () => {
  const { repo, ops } = setup();
  const { outcome, duplicate } = await repo.recordOutcome(CTX, { ...OUTCOME, outcome: 'rejected_by_customer' });
  assert.equal(duplicate, false);
  assert.equal(outcome.outcome, 'rejected_by_customer');
  assert.equal(ops('ActionOutcome.create')[0].docs[0].tenantId, 't1');
});

test('a duplicate key returns the row that already holds the idempotency key', async () => {
  const existing = { _id: 'out0', outcome: 'executed', idempotencyKey: 'proposal:p1' };
  const { repo, ops } = setup({ createError: duplicateKeyError(), outcomeLookups: [existing] });

  const { outcome, duplicate } = await repo.recordOutcome(CTX, { ...OUTCOME, outcome: 'failed' });

  assert.equal(duplicate, true);
  assert.equal(outcome.outcome, 'executed');
  assert.deepEqual(ops('ActionOutcome.findOne')[0].filter, { idempotencyKey: 'proposal:p1', tenantId: 't1' });
});

test('a duplicate key with no row to show for it is rethrown, not papered over', async () => {
  const { repo } = setup({ createError: duplicateKeyError(), outcomeLookups: [null] });
  await assert.rejects(repo.recordOutcome(CTX, OUTCOME), /duplicate key/);
});

test('any other insert error is rethrown unchanged', async () => {
  const { repo } = setup({ createError: new Error('not primary') });
  await assert.rejects(repo.recordOutcome(CTX, OUTCOME), /not primary/);
});

/* ── Atomic, conditional execution ────────────────────────────────────── */

test('execution applies the conditional write and inserts the outcome in the SAME session', async () => {
  const { repo, ops, session } = setup();
  const { outcome, duplicate } = await repo.executeCancellation(CTX, { order: ORDER, outcome: OUTCOME });

  assert.equal(duplicate, false);
  const [update] = ops('Order.findOneAndUpdate');
  assert.deepEqual(update.filter, conditionalCancelFilter(CTX, ORDER));
  assert.deepEqual(update.update, {
    $set: { status: 'cancelled', cancelledAt: AT, cancellationRef: 'cxl-o1' },
    $inc: { __v: 1 },
  });
  assert.equal(update.options.session, session);
  assert.equal(ops('ActionOutcome.create')[0].options.session, session);
  assert.deepEqual(outcome.result, { orderVersionBefore: 0, orderVersionAfter: 1, cancellationRef: 'cxl-o1' });
  assert.equal(session.ended, true);
});

test('an outcome already present inside the transaction is a duplicate, and nothing is written', async () => {
  const existing = { _id: 'out0', outcome: 'executed' };
  const { repo, ops, session } = setup({ outcomeLookups: [existing] });

  const { outcome, duplicate } = await repo.executeCancellation(CTX, { order: ORDER, outcome: OUTCOME });

  assert.equal(duplicate, true);
  assert.equal(outcome._id, 'out0');
  assert.equal(ops('Order.findOneAndUpdate').length, 0);
  assert.equal(ops('ActionOutcome.create').length, 0);
  assert.equal(session.ended, true);
});

test('A CONFLICT CAUSED BY A CONCURRENT CONFIRMATION of the same proposal reports its result', async () => {
  // The transaction's snapshot predates the winner's commit, so inside it the
  // winner's outcome was invisible and the version had already moved. Looking
  // again outside the aborted snapshot tells "someone else did this" apart from
  // "the order genuinely changed".
  const winner = { _id: 'out-winner', outcome: 'executed' };
  const { repo, ops, session } = setup({ updatedOrder: null, outcomeLookups: [null, winner] });

  const { outcome, duplicate } = await repo.executeCancellation(CTX, { order: ORDER, outcome: OUTCOME });

  assert.equal(duplicate, true);
  assert.equal(outcome._id, 'out-winner');
  assert.equal(ops('ActionOutcome.findOne').length, 2);
  assert.equal(session.ended, true);
});

test('a genuine conflict — the order changed — throws, and writes nothing', async () => {
  const { repo, ops, session } = setup({ updatedOrder: null, outcomeLookups: [null, null] });

  await assert.rejects(
    repo.executeCancellation(CTX, { order: ORDER, outcome: OUTCOME }),
    (error) => error instanceof ConcurrentModificationError,
  );
  assert.equal(ops('ActionOutcome.create').length, 0);
  assert.equal(session.ended, true);
});

test('any other failure propagates, is not mistaken for a conflict, and still ends the session', async () => {
  const { repo, ops, session } = setup({ createError: new Error('write concern timeout') });

  await assert.rejects(repo.executeCancellation(CTX, { order: ORDER, outcome: OUTCOME }), /write concern timeout/);
  assert.equal(ops('ActionOutcome.findOne').length, 1, 'no post-abort lookup for a non-conflict error');
  assert.equal(session.ended, true);
});
