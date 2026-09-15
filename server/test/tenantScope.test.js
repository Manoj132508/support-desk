import test from 'node:test';
import assert from 'node:assert/strict';
import { scoped, tenantFilter, policyScopeFilter } from '../src/db/tenantScope.js';

/**
 * INV-D, ADR 0005.
 *
 * A fake model records the filter it was handed, which is the whole point of
 * the test: the assertion is about the SHAPE OF THE QUERY, not about what came
 * back. A post-fetch authorisation check would pass a behavioural test and
 * still leak, because it fetches the foreign record first.
 */
function fakeModel() {
  const calls = [];
  const record = (name) => (filter) => {
    calls.push({ name, filter });
    return null;
  };
  return {
    calls,
    find: record('find'),
    findOne: record('findOne'),
    countDocuments: record('countDocuments'),
    create: (docs) => {
      calls.push({ name: 'create', filter: docs[0] });
      return docs;
    },
  };
}

const ctx = { tenantId: 't1' };

test('every read carries the tenant in the filter', () => {
  const Model = fakeModel();
  const repo = scoped(Model, ctx);

  repo.find({ status: 'open' });
  repo.findOne({ orderNumber: '1043' });
  // A real ObjectId: since Phase 12 a malformed id asks for nothing at all.
  repo.findById('64b7f0c2a1b2c3d4e5f60718');
  repo.countDocuments({});

  assert.equal(Model.calls.length, 4);
  for (const call of Model.calls) {
    assert.equal(call.filter.tenantId, 't1', `${call.name} must be tenant-scoped`);
  }
  assert.deepEqual(Model.calls[2].filter, { _id: '64b7f0c2a1b2c3d4e5f60718', tenantId: 't1' });
});

test('an insert carries the tenant too, so a record cannot be created unscoped', () => {
  const Model = fakeModel();
  scoped(Model, ctx).create({ orderNumber: '1043' });
  assert.equal(Model.calls[0].filter.tenantId, 't1');
});

test('a caller-supplied tenantId cannot override the context', () => {
  // The attack this closes: a request body or query string carrying
  // `tenantId` that gets spread into the filter. The context wins because it
  // is applied last.
  const Model = fakeModel();
  scoped(Model, ctx).findOne({ tenantId: 'someone-else', orderNumber: '1043' });
  assert.equal(Model.calls[0].filter.tenantId, 't1');
});

test('a missing tenant context is a loud failure, not a permissive query', () => {
  // `{ tenantId: undefined }` matches documents where the field is absent,
  // so a silent fallback here would be a cross-tenant read wearing a bug's
  // clothing.
  assert.throws(() => scoped(fakeModel(), {}), /without a tenant context/);
  assert.throws(() => scoped(fakeModel(), undefined), /without a tenant context/);
  assert.throws(() => tenantFilter(null), /without a tenant context/);
});

test('INV-D: a missing record throws the argument-free 404', async () => {
  const Model = { findOne: async () => null };
  const repo = scoped(Model, ctx);

  await assert.rejects(
    () => repo.findByIdOrNotFound('64b7f0c2a1b2c3d4e5f60718'),
    (error) => {
      // Byte-identical to "no such record" -- no message, no detail, nothing
      // that could distinguish a foreign record from an absent one.
      assert.equal(error.status, 404);
      assert.equal(error.customerMessage, null);
      assert.equal(error.detail, null);
      return true;
    },
  );
});

test('ADR 0008: the policy loader is the one deliberate cross-tenant read', () => {
  const filter = policyScopeFilter(ctx, { actionType: 'order.cancel', active: true });

  // Tenant rules plus the platform baseline, which is stored with a null
  // tenant. Read-only, confined to this one function, and named so it reads as
  // a decision rather than the oversight it would otherwise look like.
  assert.deepEqual(filter.tenantId, { $in: ['t1', null] });
  assert.equal(filter.actionType, 'order.cancel');
});

test('the policy loader still requires a tenant context', () => {
  assert.throws(() => policyScopeFilter({}), /without a tenant context/);
});
