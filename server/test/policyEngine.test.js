import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate, toStoredDecision, describeCondition } from '../src/policy/engine.js';
import { CONDITION_FIELDS, OUTCOME_LADDER } from '../src/policy/vocabulary.js';

/**
 * The policy engine: the deterministic component INV-A rests on.
 *
 * Every test here constructs plain objects and calls a function. No database,
 * no clock, no fixtures, no model -- which is the point of making the engine
 * pure, and why this suite can gate every pull request without ever flaking.
 */

const NOW = new Date('2026-09-14T12:00:00Z');
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000);
const CANCEL = { actionType: 'order.cancel' };

function world({ order = {}, customer = {} } = {}) {
  return {
    order: { status: 'paid', totalMinor: 4999, currency: 'GBP', placedAt: hoursAgo(2), ...order },
    customer: { orderCount90d: 1, ...customer },
  };
}

function rule(overrides) {
  return {
    _id: overrides.ruleKey,
    tenantId: null,
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 100,
    conditions: [],
    outcome: 'confirm-required',
    customerMessage: 'A message for the customer.',
    internalReason: 'An internal reason.',
    ...overrides,
  };
}

const status = (value) => ({ field: 'order.status', op: 'eq', value });

/* ── Deny by default ──────────────────────────────────────────────────── */

test('DENY BY DEFAULT: no rules means agent-only, never allow', () => {
  // The most important line in the engine. An unmatched proposal means the
  // situation was not anticipated, and that is exactly when a human should look.
  const decision = evaluate({ rules: [], proposal: CANCEL, world: world(), now: NOW });
  assert.equal(decision.outcome, 'agent-only');
  assert.equal(decision.defaulted, true);
  assert.equal(decision.reason, 'no_matching_rule');
  assert.equal(decision.ruleKey, null);
});

test('rules for another action type are ignored, so they cannot authorise this one', () => {
  const decision = evaluate({
    rules: [rule({ ruleKey: 'OTHER', actionType: 'order.refund', outcome: 'auto-execute' })],
    proposal: CANCEL,
    world: world(),
    now: NOW,
  });
  assert.equal(decision.reason, 'no_matching_rule');
});

test('inactive rules are ignored', () => {
  const decision = evaluate({
    rules: [rule({ ruleKey: 'OLD', active: false, outcome: 'confirm-required' })],
    proposal: CANCEL,
    world: world(),
    now: NOW,
  });
  assert.equal(decision.reason, 'no_matching_rule');
});

test('a rule with no conditions is a catch-all for its action type', () => {
  const decision = evaluate({
    rules: [rule({ ruleKey: 'BASE-CATCHALL', outcome: 'confirm-required' })],
    proposal: CANCEL,
    world: world(),
    now: NOW,
  });
  assert.equal(decision.outcome, 'confirm-required');
  assert.equal(decision.ruleKey, 'BASE-CATCHALL');
  assert.equal(decision.defaulted, false);
});

/* ── Precedence ───────────────────────────────────────────────────────── */

test('MOST RESTRICTIVE WINS, regardless of priority', () => {
  // Literal "first match wins" would let the priority-1 permissive rule shadow
  // the refusal, which was never examined. The engine evaluates every rule.
  const decision = evaluate({
    rules: [
      rule({ ruleKey: 'EARLY-PERMISSIVE', priority: 1, conditions: [status('paid')], outcome: 'confirm-required' }),
      rule({ ruleKey: 'LATE-REFUSE', priority: 999, conditions: [status('paid')], outcome: 'refuse' }),
    ],
    proposal: CANCEL,
    world: world(),
    now: NOW,
  });
  assert.equal(decision.outcome, 'refuse');
  assert.equal(decision.ruleKey, 'LATE-REFUSE');
});

test('ADR 0008: a tenant rule cannot relax a platform baseline refusal', () => {
  const decision = evaluate({
    rules: [
      rule({
        ruleKey: 'BASE-DISPATCHED',
        tenantId: null,
        priority: 50,
        conditions: [status('dispatched')],
        outcome: 'refuse',
      }),
      rule({
        ruleKey: 'TENANT-LET-IT-THROUGH',
        tenantId: 't1',
        priority: 1,
        conditions: [status('dispatched')],
        outcome: 'auto-execute',
      }),
    ],
    proposal: CANCEL,
    world: world({ order: { status: 'dispatched' } }),
    now: NOW,
  });
  assert.equal(decision.outcome, 'refuse');
  assert.equal(decision.ruleKey, 'BASE-DISPATCHED');
});

test('ADR 0008: a tenant rule CAN be more restrictive than the baseline', () => {
  const rules = [
    rule({ ruleKey: 'BASE-CATCHALL', tenantId: null, outcome: 'confirm-required' }),
    rule({
      ruleKey: 'TENANT-HIGH-VALUE',
      tenantId: 't1',
      priority: 200,
      conditions: [{ field: 'order.totalMinor', op: 'gt', value: 10_000 }],
      outcome: 'agent-only',
    }),
  ];

  const expensive = evaluate({ rules, proposal: CANCEL, world: world({ order: { totalMinor: 20_000 } }), now: NOW });
  assert.equal(expensive.outcome, 'agent-only');
  assert.equal(expensive.ruleKey, 'TENANT-HIGH-VALUE');

  const cheap = evaluate({ rules, proposal: CANCEL, world: world({ order: { totalMinor: 5_000 } }), now: NOW });
  assert.equal(cheap.outcome, 'confirm-required');
  assert.equal(cheap.ruleKey, 'BASE-CATCHALL');
});

test('among equally restrictive matches, priority chooses which rule is reported', () => {
  const decision = evaluate({
    rules: [
      rule({ ruleKey: 'B-SECOND', priority: 20, outcome: 'agent-only' }),
      rule({ ruleKey: 'A-FIRST', priority: 10, outcome: 'agent-only' }),
    ],
    proposal: CANCEL,
    world: world(),
    now: NOW,
  });
  assert.equal(decision.ruleKey, 'A-FIRST');
});

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

test('the decision does not depend on the order rules arrive in', () => {
  // Every one of the 24 orderings, including a baseline and a tenant rule that
  // share a ruleKey and version. Without the final id tie-break, which of those
  // two is REPORTED as deciding would fall back to database return order: the
  // outcome would agree, the audit record would not.
  const rules = [
    rule({ _id: 'id-b', ruleKey: 'SHARED', version: 2, tenantId: null, outcome: 'agent-only' }),
    rule({ _id: 'id-a', ruleKey: 'SHARED', version: 2, tenantId: 't1', outcome: 'agent-only' }),
    rule({ ruleKey: 'PERMISSIVE', priority: 1, outcome: 'confirm-required' }),
    rule({ ruleKey: 'NOT-MATCHING', conditions: [status('delivered')], outcome: 'refuse' }),
  ];

  const baseline = evaluate({ rules, proposal: CANCEL, world: world(), now: NOW });
  for (const ordering of permutations(rules)) {
    assert.deepEqual(evaluate({ rules: ordering, proposal: CANCEL, world: world(), now: NOW }), baseline);
  }
  assert.equal(baseline.outcome, 'agent-only');
  assert.equal(baseline.ruleId, 'id-a');
});

test('the input rules array is not mutated', () => {
  const rules = [rule({ ruleKey: 'Z', priority: 9 }), rule({ ruleKey: 'A', priority: 1 })];
  const snapshot = rules.map((r) => r.ruleKey);
  evaluate({ rules, proposal: CANCEL, world: world(), now: NOW });
  assert.deepEqual(rules.map((r) => r.ruleKey), snapshot);
});

/* ── Conditions ───────────────────────────────────────────────────────── */

test('conditions within a rule are AND-ed', () => {
  const both = [status('paid'), { field: 'order.totalMinor', op: 'lt', value: 10_000 }];
  const rules = [rule({ ruleKey: 'BOTH', conditions: both, outcome: 'refuse' })];

  assert.equal(evaluate({ rules, proposal: CANCEL, world: world(), now: NOW }).outcome, 'refuse');
  assert.equal(
    evaluate({ rules, proposal: CANCEL, world: world({ order: { totalMinor: 50_000 } }), now: NOW }).reason,
    'no_matching_rule',
  );
});

test('every operator behaves as named', () => {
  const cases = [
    [{ field: 'order.status', op: 'eq', value: 'paid' }, true],
    [{ field: 'order.status', op: 'ne', value: 'paid' }, false],
    [{ field: 'order.status', op: 'in', value: ['paid', 'packed'] }, true],
    [{ field: 'order.status', op: 'nin', value: ['paid', 'packed'] }, false],
    [{ field: 'order.totalMinor', op: 'lt', value: 4999 }, false],
    [{ field: 'order.totalMinor', op: 'lte', value: 4999 }, true],
    [{ field: 'order.totalMinor', op: 'gt', value: 4999 }, false],
    [{ field: 'order.totalMinor', op: 'gte', value: 4999 }, true],
    [{ field: 'order.currency', op: 'in', value: ['GBP', 'EUR'] }, true],
  ];
  for (const [condition, expected] of cases) {
    const decision = evaluate({
      rules: [rule({ ruleKey: 'OP', conditions: [condition], outcome: 'refuse' })],
      proposal: CANCEL,
      world: world(),
      now: NOW,
    });
    assert.equal(decision.outcome === 'refuse', expected, describeCondition(condition));
  }
});

test('order age is derived from the INJECTED now, so the same facts replay identically', () => {
  const rules = [
    rule({ ruleKey: 'OLD-ORDER', conditions: [{ field: 'order.ageHours', op: 'gt', value: 24 }], outcome: 'agent-only' }),
  ];
  const facts = world({ order: { placedAt: new Date('2026-09-13T11:00:00Z') } }); // 25h before NOW

  assert.equal(evaluate({ rules, proposal: CANCEL, world: facts, now: NOW }).outcome, 'agent-only');

  // Same facts, an earlier `now`: the order is 23 hours old and the rule no
  // longer matches. A clock read inside the engine would make these two calls
  // impossible to tell apart, and impossible to replay from the audit.
  const earlier = new Date('2026-09-14T10:00:00Z');
  assert.equal(evaluate({ rules, proposal: CANCEL, world: facts, now: earlier }).reason, 'no_matching_rule');
});

test('every registered condition field can actually be resolved from world state', () => {
  // Guards the explicit resolver against drifting from the registry. A field
  // registered but not resolvable would fail closed on every evaluation that
  // used it, silently turning a rule into a permanent escalation.
  for (const [field, spec] of Object.entries(CONDITION_FIELDS)) {
    const value =
      spec.type === 'int' ? 1_000_000_000 : spec.values ? spec.values[0] : 'GBP';
    const decision = evaluate({
      rules: [rule({ ruleKey: `RESOLVE-${field}`, conditions: [{ field, op: spec.operators[0], value }] })],
      proposal: CANCEL,
      world: world(),
      now: NOW,
    });
    assert.notEqual(decision.reason, 'incomplete_world_state', `${field} has no resolver`);
    assert.notEqual(decision.reason, 'invalid_rule', `${field} was rejected as invalid`);
  }
});

/* ── Failing closed ───────────────────────────────────────────────────── */

test('a missing fact fails closed to agent-only', () => {
  const decision = evaluate({
    rules: [rule({ ruleKey: 'FREQUENT', conditions: [{ field: 'customer.orderCount90d', op: 'gt', value: 5 }], outcome: 'refuse' })],
    proposal: CANCEL,
    world: { order: world().order },
    now: NOW,
  });
  assert.equal(decision.outcome, 'agent-only');
  assert.equal(decision.reason, 'incomplete_world_state');
  assert.equal(decision.detail.missing, 'customer.orderCount90d');
});

test('A MISSING FACT OVERRIDES A PERMISSIVE MATCH — not seeing a restriction is not permission', () => {
  // The catch-all alone would have produced confirm-required. But the refusal
  // rule could not be checked, and treating "could not check" as "did not
  // apply" would turn missing data into authorisation.
  const decision = evaluate({
    rules: [
      rule({ ruleKey: 'CATCHALL', priority: 1, outcome: 'confirm-required' }),
      rule({ ruleKey: 'FREQUENT', priority: 2, conditions: [{ field: 'customer.orderCount90d', op: 'gt', value: 5 }], outcome: 'refuse' }),
    ],
    proposal: CANCEL,
    world: { order: world().order },
    now: NOW,
  });
  assert.equal(decision.outcome, 'agent-only');
  assert.equal(decision.reason, 'incomplete_world_state');
});

test('a missing fact is not consulted when an earlier condition already rules the rule out', () => {
  // Precision, not leniency: this rule cannot match whatever orderCount90d is,
  // because the status condition already fails. Failing closed here would
  // escalate a conversation over a fact that could not have changed the answer.
  const decision = evaluate({
    rules: [
      rule({ ruleKey: 'CATCHALL', outcome: 'confirm-required' }),
      rule({
        ruleKey: 'DISPATCHED-AND-FREQUENT',
        conditions: [status('dispatched'), { field: 'customer.orderCount90d', op: 'gt', value: 5 }],
        outcome: 'refuse',
      }),
    ],
    proposal: CANCEL,
    world: { order: world().order },
    now: NOW,
  });
  assert.equal(decision.outcome, 'confirm-required');
});

test('an invalid rule reaching evaluation fails closed rather than being skipped', () => {
  // Rejection on save is a promise about the past. Defence in depth means a
  // rule that somehow arrives invalid is never quietly ignored -- ignoring a
  // broken refusal rule would be a relaxation.
  const invalids = [
    rule({ ruleKey: 'BAD-FIELD', conditions: [{ field: 'order.colour', op: 'eq', value: 'red' }] }),
    rule({ ruleKey: 'BAD-OP', conditions: [{ field: 'order.status', op: 'lt', value: 'paid' }] }),
    rule({ ruleKey: 'BAD-TYPE', conditions: [{ field: 'order.totalMinor', op: 'lt', value: '100' }] }),
    rule({ ruleKey: 'BAD-IN', conditions: [{ field: 'order.status', op: 'in', value: 'paid' }] }),
  ];
  for (const bad of invalids) {
    const decision = evaluate({ rules: [bad], proposal: CANCEL, world: world(), now: NOW });
    assert.equal(decision.outcome, 'agent-only', bad.ruleKey);
    assert.equal(decision.reason, 'invalid_rule', bad.ruleKey);
  }
});

test('a rule with an outcome that is not on the ladder cannot win by being the only match', () => {
  const decision = evaluate({
    rules: [rule({ ruleKey: 'GARBAGE', outcome: 'allow-everything' })],
    proposal: CANCEL,
    world: world(),
    now: NOW,
  });
  assert.equal(decision.outcome, 'agent-only');
  assert.equal(decision.reason, 'invalid_rule');
});

test('ADR 0007: a fail-closed decision carries no customer text derived from internal reasons', () => {
  const decision = evaluate({ rules: [], proposal: CANCEL, world: world(), now: NOW });
  assert.equal(decision.customerMessage, null);
  assert.match(decision.internalReason, /no_matching_rule/);
});

/* ── auto-execute ─────────────────────────────────────────────────────── */

test('FR-5.4: auto-execute is clamped to confirm-required, and the clamp is recorded', () => {
  const rules = [rule({ ruleKey: 'WANTS-AUTO', outcome: 'auto-execute' })];

  const clamped = evaluate({ rules, proposal: CANCEL, world: world(), now: NOW });
  assert.equal(clamped.outcome, 'confirm-required');
  assert.equal(clamped.clampedFrom, 'auto-execute');

  const modelled = evaluate({ rules, proposal: CANCEL, world: world(), now: NOW, allowAutoExecute: true });
  assert.equal(modelled.outcome, 'auto-execute');
  assert.equal(modelled.clampedFrom, null);
});

/* ── Purity and contract ──────────────────────────────────────────────── */

test('programming errors throw rather than producing a plausible decision', () => {
  assert.throws(() => evaluate({ rules: [], world: world(), now: NOW }), /actionType/);
  assert.throws(() => evaluate({ rules: [], proposal: CANCEL, world: world() }), /explicit, valid `now`/);
  assert.throws(
    () => evaluate({ rules: [], proposal: CANCEL, world: world(), now: new Date('nonsense') }),
    /explicit, valid `now`/,
  );
});

test('identical inputs produce identical decisions', () => {
  const rules = [rule({ ruleKey: 'X', conditions: [status('paid')], outcome: 'agent-only' })];
  const first = evaluate({ rules, proposal: CANCEL, world: world(), now: NOW });
  const second = evaluate({ rules, proposal: CANCEL, world: world(), now: NOW });
  assert.deepEqual(first, second);
});

test('decisions are frozen, so nothing downstream can edit an authorisation', () => {
  const decision = evaluate({ rules: [rule({ ruleKey: 'X' })], proposal: CANCEL, world: world(), now: NOW });
  assert.ok(Object.isFrozen(decision));
  assert.throws(() => {
    decision.outcome = 'auto-execute';
  }, TypeError);
});

test('the stored decision has exactly the fields ActionOutcome persists', () => {
  const decision = evaluate({
    rules: [rule({ ruleKey: 'X', conditions: [status('paid')], outcome: 'agent-only' })],
    proposal: CANCEL,
    world: world(),
    now: NOW,
  });
  const stored = toStoredDecision(decision);
  assert.deepEqual(Object.keys(stored).sort(), ['matched', 'outcome', 'ruleId', 'ruleKey', 'ruleVersion']);
  assert.deepEqual(stored.matched, ['order.status eq "paid"']);
});

const source = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('ADR 0004: the engine imports nothing but its vocabulary', () => {
  const code = withoutComments(source('../src/policy/engine.js'));
  const specifiers = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(specifiers, ['./vocabulary.js']);
  assert.ok(!/\bimport\s*\(/.test(code), 'no dynamic imports');
  assert.ok(!/\brequire\s*\(/.test(code), 'no require');
});

test('ADR 0004: the engine reads no clock, no environment and no randomness', () => {
  const code = withoutComments(source('../src/policy/engine.js'));
  for (const forbidden of ['Date.now', 'new Date(', 'process.env', 'Math.random', 'fetch(']) {
    assert.ok(!code.includes(forbidden), `engine.js must not use ${forbidden}`);
  }
});

test('the ladder the engine uses is the one the schema validates against', () => {
  assert.deepEqual([...OUTCOME_LADDER], ['auto-execute', 'confirm-required', 'agent-only', 'refuse']);
});
