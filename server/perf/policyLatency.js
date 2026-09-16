import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { evaluate } from '../src/policy/engine.js';
import { DECISION_CASES, NOW } from '../eval/policy/goldenSet.js';
import { loadRuleSets } from '../eval/policy/runPolicyEval.js';
import { formatDuration, summarise } from './stats.js';

/**
 * NFR-2: policy evaluation under 10 ms. Phase 14.
 *
 *   npm run perf:policy            the report
 *   npm run perf:policy -- --json  the numbers as JSON
 *
 * Times the REAL engine, one call at a time, in two ways.
 *
 * 1. THE SHIPPED RULES. Every decision case in the policy eval's golden set,
 *    round robin, against the rule sets the seed writes (5 rules for a tenant).
 *    This is the number NFR-2 is about.
 *
 * 2. HEADROOM. The same engine against rule sets with hundreds and thousands of
 *    extra rules, each written so that every condition but its last matches.
 *    That forces every condition of every rule to be read: the worst case per
 *    rule. It answers how many rules a tenant could add before the budget was
 *    at risk.
 *
 * REPORTED, NOT GATED. A timing is not a deterministic invariant, and Phase 1 §6
 * gates CI only on those. What IS gated is the structural half of NFR-2, "never a
 * network call": the engine imports nothing but its vocabulary, reads no clock,
 * and returns its decision synchronously (test/policyEngine.test.js).
 */

export const BUDGET_MS = 10;

/** Extra tenant rules that each read all five condition fields and then fail. */
export function worstCaseRules(count) {
  return Array.from({ length: count }, (_, index) => ({
    ruleKey: `PERF-${index}`,
    tenantId: 'perf-tenant',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 1_000 + index,
    conditions: [
      { field: 'order.status', op: 'in', value: ['placed', 'paid', 'packed'] },
      { field: 'order.ageHours', op: 'lt', value: 10_000 },
      { field: 'order.currency', op: 'eq', value: 'GBP' },
      { field: 'customer.orderCount90d', op: 'gte', value: 0 },
      // Last, and never true, so nothing short-circuits before it.
      { field: 'order.totalMinor', op: 'gt', value: 100_000_000 + index },
    ],
    outcome: 'refuse',
    customerMessage: 'Not used.',
    internalReason: 'A synthetic rule for the latency benchmark.',
  }));
}

function measure(call, { warmup, iterations }) {
  let sink = 0;
  for (let i = 0; i < warmup; i += 1) sink += call(i).outcome.length;

  const samples = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    // Using the result keeps the call from being optimised into nothing.
    sink += call(i).outcome.length;
    samples[i] = Number(process.hrtime.bigint() - start) / 1e6;
  }
  return { samples, sink };
}

export async function runPolicyLatency({ iterations = 50_000, scaleIterations = 5_000, sizes = [100, 1_000, 5_000] } = {}) {
  const sets = await loadRuleSets();
  const now = new Date(NOW);
  const rows = [];

  const cases = DECISION_CASES.map((testCase) => ({
    rules: sets[testCase.ruleSet],
    proposal: { actionType: testCase.actionType },
    world: testCase.world,
    now,
  }));
  const shipped = measure((i) => evaluate(cases[i % cases.length]), { warmup: 5_000, iterations });
  rows.push({
    name: `golden-set decisions (${cases.length} cases, seeded rules)`,
    rules: sets.acme.length,
    ...summarise(shipped.samples),
  });

  const paidOrder = DECISION_CASES.find((testCase) => testCase.id === 'acme-low-value').world;
  for (const size of sizes) {
    const rules = [...sets.acme, ...worstCaseRules(size)];
    const input = { rules, proposal: { actionType: 'order.cancel' }, world: paidOrder, now };
    const decided = evaluate(input);
    if (decided.ruleKey !== 'BASE-CANCEL-PRE-DISPATCH') {
      // The synthetic rules must cost time without changing the decision, or
      // the benchmark would be timing a different question.
      throw new Error(`worst-case rules changed the decision to ${decided.ruleKey}`);
    }
    const run = measure(() => evaluate(input), { warmup: 500, iterations: scaleIterations });
    rows.push({ name: `seeded + ${size.toLocaleString('en-GB')} worst-case rules`, rules: rules.length, ...summarise(run.samples) });
  }

  // Evaluation is linear in rules, so the largest set's p99 per rule estimates
  // where the budget would be reached. An estimate, and labelled as one.
  const largest = rows[rows.length - 1];
  const rulesAtBudget = Math.floor((BUDGET_MS / largest.p99) * largest.rules);

  return {
    machine: { cpu: os.cpus()[0]?.model?.trim(), cores: os.cpus().length, node: process.version, platform: process.platform },
    budgetMs: BUDGET_MS,
    rows,
    rulesAtBudget,
  };
}

function printReport(result) {
  const line = '='.repeat(96);
  console.log(`\n${line}\n  POLICY EVALUATION LATENCY -- NFR-2 (budget ${result.budgetMs} ms)\n${line}`);
  console.log(`  ${result.machine.cpu}, ${result.machine.cores} threads, Node ${result.machine.node}\n`);
  console.log(`  ${'rule set'.padEnd(46)}${'rules'.padStart(6)}${'p50'.padStart(10)}${'p95'.padStart(10)}${'p99'.padStart(10)}${'max'.padStart(11)}`);
  for (const row of result.rows) {
    console.log(
      `  ${row.name.padEnd(46)}${String(row.rules).padStart(6)}` +
        `${formatDuration(row.p50).padStart(10)}${formatDuration(row.p95).padStart(10)}` +
        `${formatDuration(row.p99).padStart(10)}${formatDuration(row.max).padStart(11)}`,
    );
  }
  const shipped = result.rows[0];
  console.log(
    `\n  Shipped rules: p99 ${formatDuration(shipped.p99)}, max ${formatDuration(shipped.max)} over ` +
      `${shipped.n.toLocaleString('en-GB')} calls -- ${Math.round(result.budgetMs / shipped.p99).toLocaleString('en-GB')}x under budget at p99.`,
  );
  console.log(`  Estimated rules at which p99 reaches the budget: ~${result.rulesAtBudget.toLocaleString('en-GB')} (worst case per rule).`);
  console.log('  max includes garbage-collection pauses; p99 is the figure a customer would notice.');
  console.log(`${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runPolicyLatency();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else printReport(result);
}
