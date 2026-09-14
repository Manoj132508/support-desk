import test from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_RULES } from '../src/policy/baselineRules.js';
import { evaluate } from '../src/policy/engine.js';
import { CONDITION_FIELDS } from '../src/policy/vocabulary.js';
import { PolicyRule, ORDER_STATUS } from '../src/db/models/index.js';

/**
 * The platform baseline, run through BOTH consumers -- the schema that
 * validates rules on save and the engine that evaluates them. A baseline rule
 * that one accepted and the other rejected would be a platform guarantee that
 * silently does not apply.
 */

const NOW = new Date('2026-09-14T12:00:00Z');
const CANCEL = { actionType: 'order.cancel' };

function world(status) {
  return {
    order: { status, totalMinor: 4999, currency: 'GBP', placedAt: new Date('2026-09-14T09:00:00Z') },
    customer: { orderCount90d: 1 },
  };
}

const cloneRule = (rule) => ({
  ...rule,
  tenantId: null,
  conditions: rule.conditions.map((c) => ({ ...c, value: Array.isArray(c.value) ? [...c.value] : c.value })),
});

test('every baseline rule passes the PolicyRule schema, including the save-time registry check', async () => {
  for (const rule of BASELINE_RULES) {
    // validate() rather than validateSync(): the registry check is a
    // pre('validate') hook, and validateSync() does not run hooks.
    await new PolicyRule(cloneRule(rule)).validate();
  }
});

test('the engine and the schema agree on which order statuses exist', () => {
  // Two lists that must never drift: the registry the engine reasons over and
  // the enum the Order model stores. A status in one and not the other is a
  // rule that can be written but never matches, or a real order no rule can see.
  assert.deepEqual([...CONDITION_FIELDS['order.status'].values], [...ORDER_STATUS]);
});

test('EVERY order status is covered — none falls through to deny-by-default', () => {
  // Deny-by-default would catch a gap safely, but a baseline leaning on it for
  // an ordinary status would escalate every such conversation for a reason
  // nobody wrote down.
  for (const status of ORDER_STATUS) {
    const decision = evaluate({ rules: BASELINE_RULES, proposal: CANCEL, world: world(status), now: NOW });
    assert.equal(decision.defaulted, false, `order.status "${status}" is not covered by the baseline`);
  }
});

test('the baseline outcome for each status is exactly the documented mapping', () => {
  const expected = {
    placed: 'confirm-required',
    paid: 'confirm-required',
    packed: 'confirm-required',
    dispatched: 'agent-only',
    delivered: 'refuse',
    cancelled: 'refuse',
  };
  for (const [status, outcome] of Object.entries(expected)) {
    const decision = evaluate({ rules: BASELINE_RULES, proposal: CANCEL, world: world(status), now: NOW });
    assert.equal(decision.outcome, outcome, status);
  }
});

test('dispatched and delivered get DIFFERENT outcomes', () => {
  // The distinction the Phase 3 amendment added a fourth outcome for: after
  // dispatch a human may still ask the carrier to intercept; after delivery
  // nobody may cancel at all. Collapsing them would tell an agent they may do
  // something they may not.
  const dispatched = evaluate({ rules: BASELINE_RULES, proposal: CANCEL, world: world('dispatched'), now: NOW });
  const delivered = evaluate({ rules: BASELINE_RULES, proposal: CANCEL, world: world('delivered'), now: NOW });
  assert.equal(dispatched.outcome, 'agent-only');
  assert.equal(delivered.outcome, 'refuse');
});

test('FR-5.4: no baseline rule asks for auto-execute', () => {
  assert.ok(BASELINE_RULES.every((rule) => rule.outcome !== 'auto-execute'));
});

test('ADR 0008: a tenant rule cannot relax the real baseline', () => {
  const tenantTriesToAllow = {
    ruleKey: 'TENANT-CANCEL-ANYTHING',
    tenantId: 't1',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 1,
    conditions: [{ field: 'order.status', op: 'eq', value: 'delivered' }],
    outcome: 'auto-execute',
    customerMessage: 'Sure.',
    internalReason: 'A tenant attempting to relax a platform guarantee.',
  };
  const decision = evaluate({
    rules: [...BASELINE_RULES, tenantTriesToAllow],
    proposal: CANCEL,
    world: world('delivered'),
    now: NOW,
  });
  assert.equal(decision.outcome, 'refuse');
  assert.equal(decision.ruleKey, 'BASE-CANCEL-DELIVERED');
});

test('rule keys are unique and namespaced as baseline', () => {
  const keys = BASELINE_RULES.map((rule) => rule.ruleKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((key) => key.startsWith('BASE-')));
});

test('ADR 0007: every customer message is free of internal identifiers', () => {
  for (const rule of BASELINE_RULES) {
    assert.ok(rule.customerMessage.trim(), `${rule.ruleKey} has no customer message`);
    assert.ok(rule.internalReason.trim(), `${rule.ruleKey} has no internal reason`);
    assert.doesNotMatch(rule.customerMessage, /BASE-|POL-|ruleKey|order\.status|priority/);
  }
});

test('the baseline is frozen, so a test or a seed script cannot quietly edit a platform guarantee', () => {
  assert.throws(() => {
    BASELINE_RULES[0].outcome = 'auto-execute';
  }, TypeError);
  assert.throws(() => {
    BASELINE_RULES.push({});
  }, TypeError);
});
