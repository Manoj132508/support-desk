import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Order, PolicyRule, CONDITION_FIELDS, OUTCOME_LADDER } from '../src/db/models/index.js';

const oid = () => new mongoose.Types.ObjectId();

function validOrder(overrides = {}) {
  return new Order({
    tenantId: oid(),
    customerId: oid(),
    orderNumber: '1043',
    currency: 'GBP',
    totalMinor: 129900,
    placedAt: new Date(),
    items: [{ sku: 'KB-1', name: 'Wireless keyboard', qty: 1, unitPriceMinor: 129900 }],
    ...overrides,
  });
}

test('money is integer minor units, and a float is rejected', () => {
  // order.totalMinor is a POLICY CONDITION OPERAND. A float comparison that
  // varies across platforms would make the one component whose determinism the
  // project's central claim rests on non-deterministic.
  assert.equal(validOrder().validateSync(), undefined);

  const error = validOrder({ totalMinor: 1299.5 }).validateSync();
  assert.ok(error?.errors?.totalMinor, 'a fractional total must not validate');
  assert.match(error.errors.totalMinor.message, /integer number of minor units/);
});

test('a negative total is rejected', () => {
  const error = validOrder({ totalMinor: -1 }).validateSync();
  assert.ok(error?.errors?.totalMinor);
});

test('order status is a closed set', () => {
  const error = validOrder({ status: 'refunded' }).validateSync();
  assert.ok(error?.errors?.status);
});

test('order age is derived, never stored', () => {
  // A stored age would let a rule be decided against a stale value.
  assert.equal(Order.schema.path('ageHours'), undefined);

  const order = validOrder({ placedAt: new Date(Date.now() - 3 * 3_600_000) });
  assert.ok(Math.abs(order.ageHours() - 3) < 0.01);
});

function validRule(overrides = {}) {
  return new PolicyRule({
    ruleKey: 'POL-CANCEL-DISPATCHED',
    version: 1,
    actionType: 'order.cancel',
    outcome: 'refuse',
    conditions: [{ field: 'order.status', op: 'eq', value: 'dispatched' }],
    customerMessage: 'This order has already shipped, so I cannot cancel it from here.',
    internalReason: 'Cancellation blocked once an order is dispatched.',
    ...overrides,
  });
}

test('a valid baseline rule validates, with a null tenant', () => {
  const rule = validRule();
  assert.equal(rule.validateSync(), undefined);
  assert.equal(rule.tenantId, null, 'a baseline rule belongs to no tenant (ADR 0008)');
});

test('the outcome ladder is ordered most permissive first', () => {
  // "More restrictive wins" is implemented as "higher index wins", which is
  // what makes ADR 0008's baseline layering safe with no branch in the engine.
  assert.deepEqual(OUTCOME_LADDER, [
    'auto-execute',
    'confirm-required',
    'agent-only',
    'refuse',
  ]);
  assert.deepEqual(PolicyRule.schema.path('outcome').enumValues, OUTCOME_LADDER);
});

test('ADR 0007: both reason channels are required on every rule', () => {
  // Writing the human-facing sentence is part of writing the rule. A rule with
  // no customerMessage would fall back to generic copy at runtime, which is a
  // safety net rather than an intention.
  const missingCustomer = validRule({ customerMessage: undefined }).validateSync();
  assert.ok(missingCustomer?.errors?.customerMessage);

  const missingInternal = validRule({ internalReason: undefined }).validateSync();
  assert.ok(missingInternal?.errors?.internalReason);
});

test('a condition naming an unregistered field is rejected at save, not at evaluation', async () => {
  // A bad rule sitting in the database looking fine until it is asked to
  // decide something is the worst possible time to find out.
  const rule = validRule({ conditions: [{ field: 'order.colour', op: 'eq', value: 'red' }] });
  await assert.rejects(() => rule.validate(), /Unknown condition field: order.colour/);
});

test('an operator the field type does not allow is rejected', async () => {
  const rule = validRule({ conditions: [{ field: 'order.ageHours', op: 'eq', value: 3 }] });
  await assert.rejects(() => rule.validate(), /not permitted on order.ageHours/);
});

test('an out-of-range enum value is rejected', async () => {
  const rule = validRule({ conditions: [{ field: 'order.status', op: 'eq', value: 'refunded' }] });
  await assert.rejects(() => rule.validate(), /no such value: refunded/);
});

test('an int field rejects a non-integer operand', async () => {
  const rule = validRule({
    conditions: [{ field: 'order.totalMinor', op: 'gt', value: 100.5 }],
  });
  await assert.rejects(() => rule.validate(), /requires an integer value/);
});

test('the condition registry is small and closed', () => {
  // The registry is the engine's entire input contract. Keeping it enumerable
  // is what makes exhaustive testing possible and the golden set meaningful.
  const fields = Object.keys(CONDITION_FIELDS);
  assert.ok(fields.length <= 8, 'the vocabulary should stay small enough to reason about');
  for (const [name, spec] of Object.entries(CONDITION_FIELDS)) {
    assert.ok(['enum', 'int'].includes(spec.type), `${name} has an unexpected type`);
    assert.ok(spec.operators.length > 0, `${name} declares no operators`);
  }
});

test('rule versions are unique per key and tenant', () => {
  const indexes = PolicyRule.schema.indexes();
  const versionIndex = indexes.find(
    ([fields]) => fields.ruleKey === 1 && fields.version === 1,
  );
  assert.ok(versionIndex);
  assert.equal(versionIndex[1].unique, true);
});
