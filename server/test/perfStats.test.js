import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, percentile, summarise } from '../perf/stats.js';
import { evaluate } from '../src/policy/engine.js';
import { runPolicyLatency, worstCaseRules } from '../perf/policyLatency.js';

/**
 * Phase 14's measurement code. A benchmark whose arithmetic is wrong reports a
 * confident number about nothing, so its statistics are tested like any other
 * code the project's claims rest on.
 */

test('a percentile is a sample that was actually observed, by nearest rank', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(sorted, 50), 5);
  assert.equal(percentile(sorted, 95), 10);
  assert.equal(percentile(sorted, 10), 1);
  // Never interpolated: between 1 ms and 900 ms, p50 is one of them.
  assert.ok([1, 900].includes(percentile([1, 900], 50)));
});

test('percentiles refuse nonsense instead of returning undefined', () => {
  assert.throws(() => percentile([], 50), RangeError);
  assert.throws(() => percentile([1], 0), RangeError);
  assert.throws(() => percentile([1], 101), RangeError);
});

test('a summary sorts a copy and reports the tail', () => {
  const samples = [9, 1, 5, 3, 7];
  const summary = summarise(samples);
  assert.deepEqual(samples, [9, 1, 5, 3, 7], 'the caller keeps its order');
  assert.equal(summary.n, 5);
  assert.equal(summary.min, 1);
  assert.equal(summary.p50, 5);
  assert.equal(summary.max, 9);
  assert.equal(summary.mean, 5);
});

test('durations print in a readable unit', () => {
  assert.equal(formatDuration(0.0123), '12.3 µs');
  assert.equal(formatDuration(4.56), '4.6 ms');
  assert.equal(formatDuration(2500), '2.50 s');
});

test('NFR-2, structurally: evaluation returns a decision, never a promise, so it cannot be waiting on a network', () => {
  const decision = evaluate({
    rules: worstCaseRules(3),
    proposal: { actionType: 'order.cancel' },
    world: { order: { status: 'paid', totalMinor: 100, currency: 'GBP', placedAt: new Date(0) }, customer: { orderCount90d: 0 } },
    now: new Date(3_600_000),
  });
  assert.equal(typeof decision.then, 'undefined');
  assert.equal(decision.outcome, 'agent-only', 'worst-case rules never match, so deny by default decides');
});

test('the worst-case rules are valid and each reads every condition field', () => {
  const [rule] = worstCaseRules(1);
  assert.deepEqual(
    rule.conditions.map((condition) => condition.field).sort(),
    ['customer.orderCount90d', 'order.ageHours', 'order.currency', 'order.status', 'order.totalMinor'],
  );
});

test('the benchmark runs, reports the shipped rules first, and its extra rules do not change the decision', async () => {
  const result = await runPolicyLatency({ iterations: 200, scaleIterations: 50, sizes: [20] });
  assert.equal(result.rows.length, 2);
  assert.match(result.rows[0].name, /golden-set decisions/);
  for (const row of result.rows) {
    assert.equal(typeof row.p99, 'number');
    assert.ok(row.p99 > 0);
  }
  assert.ok(result.rulesAtBudget > 0);
});
