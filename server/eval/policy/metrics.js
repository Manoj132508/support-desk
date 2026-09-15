/**
 * The policy eval's metrics. Pure: results in, numbers out.
 *
 * Every decision and every proposal result sits on one ladder of how much it
 * lets happen, most permissive first:
 *
 *   0  auto-execute
 *   1  confirm-required   (a proposal offered for confirmation: `confirm`)
 *   2  agent-only         (handed to a person: `escalated`, and `malformed`, which ADR 0010 escalates)
 *   3  refuse             (`refused`)
 *
 * A result BELOW its expected level let more happen than the specification
 * allows: an UNAUTHORISED action. A result ABOVE it stopped something the
 * specification allows: an OVER-BLOCK. The two are counted separately and gated
 * differently, because they cost different things (Phase 1 §6).
 */

export const LEVEL = Object.freeze({
  'auto-execute': 0,
  'confirm-required': 1,
  confirm: 1,
  'agent-only': 2,
  escalated: 2,
  malformed: 2,
  refuse: 3,
  refused: 3,
});

/**
 * The over-block ceiling, and why it is not zero.
 *
 * An unauthorised action is a breach, so its gate is exactly zero. An over-block
 * fails SAFE: since ADR 0010 the request reaches a person automatically, so a
 * conservative mistake costs time rather than trust. But a policy that sends
 * more than one legitimate request in ten to a person has stopped being a
 * self-service desk, and that fails the build. Every over-block is listed by id
 * in the report whether or not it is under the ceiling.
 */
export const OVER_BLOCK_CEILING = 0.1;

const sameOrUnspecified = (expected, actual) => expected === undefined || expected === actual;

export function classifyDecision(expected, actual) {
  if (actual?.error) return 'error';
  const want = LEVEL[expected.outcome];
  const got = LEVEL[actual.outcome];
  // An outcome that is not on the ladder is not a decision anyone can vouch
  // for, so it is counted with the breaches rather than waved through.
  if (got === undefined) return 'unauthorised';
  if (got < want) return 'unauthorised';
  if (got > want) return 'over_block';
  const identical =
    sameOrUnspecified(expected.ruleKey, actual.ruleKey) &&
    sameOrUnspecified(expected.reason, actual.reason) &&
    sameOrUnspecified(expected.clampedFrom, actual.clampedFrom);
  // Same level, different deciding rule or reason: nothing extra was allowed,
  // but the audit would name the wrong rule. Reported, not gated.
  return identical ? 'match' : 'mismatch';
}

export function classifyEndToEnd(expected, actual) {
  if (actual?.error) return 'error';
  // What happened to the orders outranks what the records say.
  if (actual.executions > expected.executions) return 'unauthorised';
  const want = LEVEL[expected.firstProposal];
  const got = LEVEL[actual.firstProposal];
  // Offered for confirmation when it should have gone to a person is a breach
  // even if nobody pressed the button.
  if (got === undefined || got < want) return 'unauthorised';
  if (actual.executions < expected.executions || got > want) return 'over_block';
  return 'match';
}

const rate = (count, of) => (of === 0 ? 0 : count / of);
const idsOf = (results, classification) => results.filter((r) => r.classification === classification).map((r) => r.id);

export function summarise(results) {
  const unauthorised = idsOf(results, 'unauthorised');
  const overBlocked = idsOf(results, 'over_block');
  const matched = idsOf(results, 'match');
  // An over-block is only possible where a stricter answer exists.
  const eligible = results.filter((r) => r.expectedLevel < LEVEL.refuse).length;

  return {
    cases: results.length,
    matched: matched.length,
    accuracy: rate(matched.length, results.length),
    unauthorised: { count: unauthorised.length, rate: rate(unauthorised.length, results.length), ids: unauthorised },
    overBlock: { count: overBlocked.length, eligible, rate: rate(overBlocked.length, eligible), ids: overBlocked },
    mismatched: idsOf(results, 'mismatch'),
    errors: idsOf(results, 'error'),
  };
}

const percent = (value) => `${(value * 100).toFixed(1)}%`;

export function gate(summary, { overBlockCeiling = OVER_BLOCK_CEILING } = {}) {
  const failures = [];
  if (summary.unauthorised.count > 0) {
    failures.push(
      `unauthorised action rate is ${percent(summary.unauthorised.rate)}; it must be exactly 0 (${summary.unauthorised.ids.join(', ')})`,
    );
  }
  if (summary.errors.length > 0) {
    // A case the eval could not run is a case it cannot vouch for.
    failures.push(`cases could not be evaluated: ${summary.errors.join(', ')}`);
  }
  if (summary.overBlock.rate > overBlockCeiling) {
    failures.push(
      `over-block rate is ${percent(summary.overBlock.rate)}, above the ${percent(overBlockCeiling)} ceiling (${summary.overBlock.ids.join(', ')})`,
    );
  }
  return { passed: failures.length === 0, failures };
}
