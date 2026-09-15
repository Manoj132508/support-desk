import { runPolicyEval } from './runPolicyEval.js';
import { OVER_BLOCK_CEILING, gate } from './metrics.js';
import { NOW } from './goldenSet.js';

/**
 * npm run eval:policy               the report
 * npm run eval:policy -- --check    the report, and exit 1 if a gate fails (CI)
 * npm run eval:policy -- --json     the results as JSON
 */

const args = new Set(process.argv.slice(2));
const percent = (value) => `${(value * 100).toFixed(1)}%`;

function describe(result, side) {
  const value = result[side];
  if (value?.error) return `error: ${value.error}`;
  if (result.kind === 'decision') {
    const extras = [value.ruleKey, value.reason, value.clampedFrom && `clamped from ${value.clampedFrom}`].filter(Boolean);
    return `${value.outcome}${extras.length ? ` (${extras.join(', ')})` : ''}`;
  }
  return `${value.firstProposal}, ${value.executions} cancelled`;
}

function printReport(results, summary) {
  const rule = '='.repeat(78);
  const decisions = results.filter((r) => r.kind === 'decision').length;
  console.log(`\n${rule}\n  POLICY EVAL -- Phase 1 §7.2\n${rule}`);
  console.log(`  ${summary.cases} cases: ${decisions} decisions, ${summary.cases - decisions} end to end.   now = ${NOW}\n`);
  console.log(`  unauthorised action rate   ${percent(summary.unauthorised.rate).padStart(6)}   gate: exactly 0`);
  console.log(
    `  over-block rate            ${percent(summary.overBlock.rate).padStart(6)}   gate: at most ${percent(OVER_BLOCK_CEILING)}` +
      `   (${summary.overBlock.count} of ${summary.overBlock.eligible} that could be over-blocked)`,
  );
  console.log(`  exact match                ${percent(summary.accuracy).padStart(6)}   reported`);
  console.log('\n  PER CASE');
  for (const result of results) {
    const ok = result.classification === 'match';
    const line = `  ${ok ? 'ok' : '!!'}  ${result.id.padEnd(46)} ${describe(result, 'actual')}`;
    console.log(ok ? line : `${line}\n      expected ${describe(result, 'expected')}   [${result.classification.toUpperCase()}]\n      why: ${result.why}`);
  }
}

const { results, summary } = await runPolicyEval();

if (args.has('--json')) console.log(JSON.stringify({ now: NOW, summary, results }, null, 2));
else printReport(results, summary);

if (args.has('--check')) {
  const verdict = gate(summary);
  console.log(`\n  GATE: ${verdict.passed ? 'PASS' : 'FAIL'}`);
  for (const failure of verdict.failures) console.log(`    - ${failure}`);
  console.log('');
  process.exitCode = verdict.passed ? 0 : 1;
}
