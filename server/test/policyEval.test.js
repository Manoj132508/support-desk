import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuleSets, runPolicyEval } from '../eval/policy/runPolicyEval.js';
import {
  LEVEL,
  OVER_BLOCK_CEILING,
  classifyDecision,
  classifyEndToEnd,
  gate,
  summarise,
} from '../eval/policy/metrics.js';
import { DECISION_CASES, END_TO_END_CASES } from '../eval/policy/goldenSet.js';
import { BASELINE_RULES } from '../src/policy/baselineRules.js';
import { CONDITION_FIELDS, DECISION_REASONS } from '../src/policy/vocabulary.js';

/**
 * The policy eval (Phase 1 §7.2). Three kinds of test: the golden set passes
 * against the real engine and the seeded rules; the metric maths is right; and
 * the eval has teeth -- a broken engine or a weakened rule set makes it fail.
 */

/* ── The golden set, against what ships ───────────────────────────────── */

test('Phase 1 §6: the golden set passes both gates against the real engine and the seeded rules', async () => {
  const { summary } = await runPolicyEval();
  assert.deepEqual(gate(summary).failures, []);
  assert.equal(summary.unauthorised.count, 0);
  assert.equal(summary.overBlock.count, 0);
  assert.deepEqual(summary.mismatched, []);
  assert.equal(summary.accuracy, 1);
});

/* ── The golden set is well formed, and covers what it claims ─────────── */

const ALL_CASES = [...DECISION_CASES, ...END_TO_END_CASES];

test('every case has a unique id, a level on the ladder, and a reason a person could check', () => {
  assert.equal(new Set(ALL_CASES.map((c) => c.id)).size, ALL_CASES.length);
  for (const c of DECISION_CASES) {
    assert.ok(LEVEL[c.expected.outcome] !== undefined, c.id);
  }
  for (const c of END_TO_END_CASES) {
    assert.ok(LEVEL[c.expected.firstProposal] !== undefined, c.id);
    assert.ok([0, 1].includes(c.expected.executions), c.id);
  }
  for (const c of ALL_CASES) assert.ok(c.why.length >= 30, `${c.id} needs a real reason`);
});

test('every order status is decided under the baseline alone', () => {
  const statuses = new Set(DECISION_CASES.filter((c) => c.ruleSet === 'globex').map((c) => c.world.order?.status));
  for (const status of CONDITION_FIELDS['order.status'].values) assert.ok(statuses.has(status), status);
});

test('every baseline rule is the expected decider somewhere, and every fail-closed reason appears', () => {
  const deciders = new Set(DECISION_CASES.map((c) => c.expected.ruleKey));
  for (const rule of BASELINE_RULES) assert.ok(deciders.has(rule.ruleKey), rule.ruleKey);
  const reasons = new Set(DECISION_CASES.map((c) => c.expected.reason));
  for (const reason of DECISION_REASONS) assert.ok(reasons.has(reason), reason);
  assert.ok(DECISION_CASES.some((c) => c.expected.clampedFrom === 'auto-execute'), 'the clamp is covered');
});

test('the end-to-end cases include the attacks and races INV-A is about', () => {
  const ids = END_TO_END_CASES.map((c) => c.id);
  for (const id of [
    'e2e-asserted-authorisation',
    'e2e-another-customers-order',
    'e2e-shipped-before-confirmation',
    'e2e-rule-tightened-before-confirmation',
    'e2e-confirmed-twice',
    'e2e-someone-else-confirms',
  ]) {
    assert.ok(ids.includes(id), id);
  }
});

test('the tenant rule sets are built from the seed, not from a copy kept beside the eval', async () => {
  const sets = await loadRuleSets();
  assert.ok(sets.acme.some((rule) => rule.ruleKey === 'TENANT-HIGH-VALUE'));
  assert.equal(sets.globex.some((rule) => rule.ruleKey === 'TENANT-HIGH-VALUE'), false);
  assert.equal(sets.globex.length, BASELINE_RULES.length);
});

/* ── The metric maths ──────────────────────────────────────────────────── */

test('a decision more permissive than specified is unauthorised; more restrictive is an over-block', () => {
  assert.equal(classifyDecision({ outcome: 'refuse' }, { outcome: 'agent-only' }), 'unauthorised');
  assert.equal(classifyDecision({ outcome: 'agent-only' }, { outcome: 'confirm-required' }), 'unauthorised');
  assert.equal(classifyDecision({ outcome: 'confirm-required' }, { outcome: 'agent-only' }), 'over_block');
  assert.equal(classifyDecision({ outcome: 'confirm-required' }, { outcome: 'confirm-required' }), 'match');
});

test('an outcome off the ladder counts as a breach, not as a pass', () => {
  assert.equal(classifyDecision({ outcome: 'refuse' }, { outcome: 'approve' }), 'unauthorised');
});

test('the same level with a different deciding rule is a mismatch: nothing extra allowed, but the audit would be wrong', () => {
  assert.equal(
    classifyDecision({ outcome: 'agent-only', ruleKey: 'TENANT-HIGH-VALUE' }, { outcome: 'agent-only', ruleKey: 'BASE-CANCEL-DISPATCHED' }),
    'mismatch',
  );
});

test('end to end, an order cancelled that should not have been is unauthorised, whatever the records say', () => {
  assert.equal(classifyEndToEnd({ firstProposal: 'escalated', executions: 0 }, { firstProposal: 'escalated', executions: 1 }), 'unauthorised');
});

test('end to end, a proposal offered for confirmation that should have gone to a person is unauthorised, even unconfirmed', () => {
  assert.equal(classifyEndToEnd({ firstProposal: 'malformed', executions: 0 }, { firstProposal: 'confirm', executions: 0 }), 'unauthorised');
});

test('end to end, a legitimate cancellation that did not happen is an over-block', () => {
  assert.equal(classifyEndToEnd({ firstProposal: 'confirm', executions: 1 }, { firstProposal: 'confirm', executions: 0 }), 'over_block');
});

test('the over-block rate counts only cases where a stricter answer was possible', () => {
  const summary = summarise([
    { id: 'a', classification: 'match', expectedLevel: LEVEL.refuse },
    { id: 'b', classification: 'over_block', expectedLevel: LEVEL['confirm-required'] },
    { id: 'c', classification: 'match', expectedLevel: LEVEL['agent-only'] },
  ]);
  assert.equal(summary.overBlock.eligible, 2);
  assert.equal(summary.overBlock.rate, 0.5);
  assert.deepEqual(summary.overBlock.ids, ['b']);
});

test('the gate: one unauthorised case fails, however good everything else is', () => {
  const results = Array.from({ length: 99 }, (_, i) => ({ id: `ok-${i}`, classification: 'match', expectedLevel: 1 }));
  results.push({ id: 'breach', classification: 'unauthorised', expectedLevel: 2 });
  const verdict = gate(summarise(results));
  assert.equal(verdict.passed, false);
  assert.match(verdict.failures[0], /breach/);
});

test('the gate: over-blocking fails only above the stated ceiling', () => {
  const at = (overBlocked) =>
    Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, classification: i < overBlocked ? 'over_block' : 'match', expectedLevel: 1 }));
  assert.equal(OVER_BLOCK_CEILING, 0.1);
  assert.equal(gate(summarise(at(1))).passed, true);
  assert.equal(gate(summarise(at(2))).passed, false);
});

test('a case the eval could not run fails the gate: an eval that crashes cannot vouch for anything', () => {
  const verdict = gate(summarise([{ id: 'boom', classification: 'error', expectedLevel: 1 }]));
  assert.equal(verdict.passed, false);
});

/* ── Teeth ────────────────────────────────────────────────────────────── */

test('TEETH: an engine that always offers confirmation is caught', async () => {
  const permissive = () => ({ outcome: 'confirm-required', ruleKey: 'SABOTAGE', reason: null, clampedFrom: null });
  const { summary } = await runPolicyEval({ evaluate: permissive, endToEndCases: [] });
  assert.ok(summary.unauthorised.count >= 10, `only ${summary.unauthorised.count} caught`);
  assert.equal(gate(summary).passed, false);
});

test('TEETH: an engine that refuses everything is caught by the ceiling, and breaches nothing', async () => {
  const refuseAll = () => ({ outcome: 'refuse', ruleKey: 'SABOTAGE', reason: null, clampedFrom: null });
  const { summary } = await runPolicyEval({ evaluate: refuseAll, endToEndCases: [] });
  assert.equal(summary.unauthorised.count, 0);
  assert.ok(summary.overBlock.rate > OVER_BLOCK_CEILING);
  assert.equal(gate(summary).passed, false);
});

test('TEETH: a rule change letting dispatched orders be confirmed is caught end to end, where orders really change', async () => {
  const sets = await loadRuleSets();
  const weaken = (rules) =>
    rules
      .filter((rule) => rule.ruleKey !== 'BASE-CANCEL-DISPATCHED')
      .map((rule) =>
        rule.ruleKey === 'BASE-CANCEL-PRE-DISPATCH'
          ? { ...rule, conditions: [{ field: 'order.status', op: 'in', value: ['placed', 'paid', 'packed', 'dispatched'] }] }
          : rule,
      );
  const weakened = Object.fromEntries(Object.entries(sets).map(([name, rules]) => [name, weaken(rules)]));

  const { summary } = await runPolicyEval({ ruleSets: weakened });

  assert.ok(summary.unauthorised.ids.includes('base-dispatched'));
  assert.ok(summary.unauthorised.ids.includes('e2e-dispatched-goes-to-a-person'));
  assert.ok(summary.unauthorised.ids.includes('e2e-shipped-before-confirmation'));
  assert.equal(gate(summary).passed, false);
});
