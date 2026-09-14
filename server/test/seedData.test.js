import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedData, stableId, assertSafeToSeed, DEMO_PASSWORD } from '../scripts/seedData.js';
import { Tenant, User, Customer, Order, PolicyRule, ORDER_STATUS } from '../src/db/models/index.js';
import { BASELINE_RULES } from '../src/policy/baselineRules.js';
import { evaluate } from '../src/policy/engine.js';
import { validateRuleDefinition } from '../src/policy/policyAdmin.js';
import { MIN_PASSWORD_LENGTH } from '../src/auth/registration.js';

/**
 * The seed builder. A demo is only evidence if it can be reproduced, and only
 * if it shows what it claims to -- so the seeded documents are validated against
 * their real schemas, and the policy engine is run over the seeded orders.
 */

const NOW = new Date('2026-09-15T12:00:00Z');
const fakeHash = async (plain) => `hashed(${plain.length})`;
const build = () => buildSeedData({ now: NOW, hashPassword: fakeHash });

test('every seeded document is valid under its real schema', async () => {
  const data = await build();
  for (const doc of data.tenants) assert.equal(new Tenant(doc).validateSync(), undefined, doc.slug);
  for (const doc of data.customers) assert.equal(new Customer(doc).validateSync(), undefined, doc.email);
  for (const doc of data.users) assert.equal(new User(doc).validateSync(), undefined, doc.email);
  for (const doc of data.orders) assert.equal(new Order(doc).validateSync(), undefined, doc.orderNumber);
  // validate(), not validateSync(): the rule registry check is a pre-validate hook.
  //
  // No structuredClone here. The first version cloned each rule, and the clone
  // turned every ObjectId into a plain object holding a byte buffer -- so the
  // schema rejected "_id" as uncastable and the test failed on a valid seed.
  // It is the same family of bug as an aggregation that does not cast ids: a
  // value that prints like an id but has lost its type. Each test builds its
  // data fresh, so there was nothing for the clone to protect.
  for (const doc of data.policyRules) await new PolicyRule(doc).validate();
});

test('every order status is represented, so every baseline rule meets a real record', async () => {
  const data = await build();
  const statuses = new Set(data.orders.map((order) => order.status));
  for (const status of ORDER_STATUS) assert.ok(statuses.has(status), `no seeded order is ${status}`);
});

function worldFor(data, orderNumber) {
  const order = data.orders.find((o) => o.orderNumber === orderNumber);
  const ninetyDaysAgo = new Date(NOW.getTime() - 90 * 24 * 3_600_000);
  const orderCount90d = data.orders.filter(
    (o) => o.customerId.equals(order.customerId) && o.placedAt >= ninetyDaysAgo,
  ).length;
  return {
    order: { status: order.status, totalMinor: order.totalMinor, currency: order.currency, placedAt: order.placedAt },
    customer: { orderCount90d },
  };
}

function rulesFor(data, tenantSlug) {
  const tenant = data.tenants.find((t) => t.slug === tenantSlug);
  return data.policyRules.filter((rule) => rule.tenantId === null || rule.tenantId.equals(tenant._id));
}

test('THE DEMO SHOWS WHAT IT CLAIMS: the engine, run over the seeded data', async () => {
  const data = await build();
  const rules = rulesFor(data, 'acme');
  const decide = (orderNumber) =>
    evaluate({ rules, proposal: { actionType: 'order.cancel' }, world: worldFor(data, orderNumber), now: NOW });

  // The ordinary cancellation.
  assert.equal(decide(data.demo.cancellable).outcome, 'confirm-required');
  // The mid-flight order is confirmable NOW -- it becomes a refusal only once
  // it has been dispatched between proposal and confirmation.
  assert.equal(decide(data.demo.dispatchMidFlight).outcome, 'confirm-required');
  // ADR 0008: the tenant rule makes the high-value order stricter than the
  // baseline alone would.
  const highValue = decide(data.demo.highValue);
  assert.equal(highValue.outcome, 'agent-only');
  assert.equal(highValue.ruleKey, 'TENANT-HIGH-VALUE');

  assert.equal(decide('1044').outcome, 'agent-only'); // dispatched
  assert.equal(decide('1045').outcome, 'refuse'); // delivered
  assert.equal(decide('1046').outcome, 'refuse'); // already cancelled
});

test('the mid-flight order becomes a refusal once dispatched, as the demo relies on', async () => {
  const data = await build();
  const world = worldFor(data, data.demo.dispatchMidFlight);
  const dispatched = { ...world, order: { ...world.order, status: 'dispatched' } };
  const decision = evaluate({
    rules: rulesFor(data, 'acme'),
    proposal: { actionType: 'order.cancel' },
    world: dispatched,
    now: NOW,
  });
  assert.equal(decision.outcome, 'agent-only');
  assert.equal(decision.ruleKey, 'BASE-CANCEL-DISPATCHED');
});

test('the baseline is seeded exactly, at version 1, belonging to no tenant', async () => {
  const data = await build();
  const baseline = data.policyRules.filter((rule) => rule.tenantId === null);
  assert.deepEqual(baseline.map((r) => r.ruleKey).sort(), BASELINE_RULES.map((r) => r.ruleKey).sort());
  assert.ok(baseline.every((rule) => rule.version === 1 && rule.active));
});

test('the demo tenant rule would pass the admin validator, like any rule a lead could write', async () => {
  const data = await build();
  const tenantRule = data.policyRules.find((rule) => rule.ruleKey === 'TENANT-HIGH-VALUE');
  assert.deepEqual(validateRuleDefinition(tenantRule), []);
});

test('ADR 0005: isolation fixtures exist — another customer’s order, and another tenant’s', async () => {
  const data = await build();
  const byNumber = Object.fromEntries(data.orders.map((o) => [o.orderNumber, o]));
  const ana = data.customers.find((c) => c.email === 'ana@acme.test');

  const otherCustomer = byNumber[data.demo.otherCustomersOrder];
  assert.ok(otherCustomer.tenantId.equals(ana.tenantId), 'same tenant');
  assert.ok(!otherCustomer.customerId.equals(ana._id), 'different customer');

  const otherTenant = byNumber[data.demo.otherTenantsOrder];
  assert.ok(!otherTenant.tenantId.equals(ana.tenantId), 'different tenant');
});

test('customer accounts link to a profile in their own tenant; staff accounts link to none', async () => {
  const data = await build();
  for (const account of data.users) {
    if (account.role === 'customer') {
      const profile = data.customers.find((c) => c._id.equals(account.customerId));
      assert.ok(profile, `${account.email} has no profile`);
      assert.ok(profile.tenantId.equals(account.tenantId), `${account.email} is linked across tenants`);
    } else {
      assert.equal(account.customerId, null, `${account.email} is staff and must not own orders`);
    }
  }
});

test('emails are unique within each tenant, matching the login index', async () => {
  const data = await build();
  const keys = data.users.map((u) => `${u.tenantId}:${u.email}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('ids are deterministic, so re-seeding cannot create duplicates', async () => {
  const first = await build();
  const second = await build();
  assert.deepEqual(
    first.orders.map((o) => String(o._id)),
    second.orders.map((o) => String(o._id)),
  );
  assert.equal(String(stableId('tenant:acme')), String(stableId('tenant:acme')));
  assert.notEqual(String(stableId('tenant:acme')), String(stableId('tenant:globex')));
});

test('passwords are hashed through the injected function and never stored in plain text', async () => {
  let calls = 0;
  const data = await buildSeedData({
    now: NOW,
    hashPassword: async (plain) => {
      calls += 1;
      return `hashed(${plain.length})`;
    },
  });
  assert.equal(calls, 1);
  assert.ok(DEMO_PASSWORD.length >= MIN_PASSWORD_LENGTH);
  for (const account of data.users) {
    assert.equal(account.password, undefined);
    assert.ok(!JSON.stringify(account).includes(DEMO_PASSWORD));
  }
});

test('the builder refuses to run without a hashing function rather than falling back', async () => {
  await assert.rejects(buildSeedData({ now: NOW }), /requires a hashPassword function/);
});

test('demo data with a published password can never be seeded into production', () => {
  assert.throws(() => assertSafeToSeed({ NODE_ENV: 'production' }), /Refusing to seed/);
  assert.doesNotThrow(() => assertSafeToSeed({ NODE_ENV: 'development' }));
  assert.doesNotThrow(() => assertSafeToSeed({}));
});
