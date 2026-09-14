import {
  CONDITION_FIELDS,
  DEFAULT_OUTCOME,
  OUTCOME_LADDER,
  restrictiveness,
} from './vocabulary.js';

/**
 * THE POLICY ENGINE. The deterministic component INV-A rests on.
 *
 *     evaluate({ rules, proposal, world, now }) -> decision
 *
 * A pure function. It reads no database, no clock, no environment and no
 * network: rules and world state are passed in already loaded, and so is
 * `now`. That is NFR-6 made literal, and it is what makes three things true at
 * once --
 *
 *   - it can be tested exhaustively, in milliseconds, with no fixtures;
 *   - the execution-time re-check (ADR 0003) is effectively free;
 *   - the policy eval can gate every PR, because there is no model and no
 *     flakiness anywhere in its path.
 *
 * TWO KINDS OF BAD INPUT, TREATED DIFFERENTLY ON PURPOSE.
 *
 *   Programming errors -- no proposal, no `now` -- THROW. They mean the caller
 *   is broken, and a broken caller should fail loudly in a test rather than
 *   produce a plausible-looking decision.
 *
 *   Data conditions -- a fact the rules need is missing, or a rule is invalid
 *   -- FAIL CLOSED to `agent-only`. An evaluation that cannot see the facts
 *   cannot authorise anything, but it also should not strand the customer, so
 *   it hands the conversation to a person and says why.
 */

/* ── Reading the world ─────────────────────────────────────────────────── */

/**
 * One explicit resolver per registry field, rather than a generic path walk
 * over the world object.
 *
 * A generic `field.split('.').reduce(...)` would resolve anything, including
 * paths nobody registered and properties inherited from Object.prototype. The
 * registry is closed, so the resolver is closed too -- and a test asserts every
 * registered field has a resolver, so the two cannot drift.
 */
function resolveField(field, world, now) {
  switch (field) {
    case 'order.status':
      return world?.order?.status;
    case 'order.totalMinor':
      return world?.order?.totalMinor;
    case 'order.currency':
      return world?.order?.currency;
    case 'order.ageHours': {
      // Derived here, at evaluation, and never stored (Phase 3 §9) -- a stored
      // age would let a rule be decided against a stale value. And derived
      // from the INJECTED `now`, so the same inputs give the same answer
      // whenever the function is called.
      const placedAt = world?.order?.placedAt;
      if (placedAt === undefined || placedAt === null) return undefined;
      const placed = placedAt instanceof Date ? placedAt.getTime() : Date.parse(placedAt);
      if (!Number.isFinite(placed)) return undefined;
      return (now.getTime() - placed) / 3_600_000;
    }
    case 'customer.orderCount90d':
      return world?.customer?.orderCount90d;
    default:
      return undefined;
  }
}

export const RESOLVABLE_FIELDS = Object.freeze(Object.keys(CONDITION_FIELDS));

class InvalidCondition extends Error {}

function compare(op, actual, expected) {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'ne':
      return actual !== expected;
    case 'in':
      if (!Array.isArray(expected)) throw new InvalidCondition(`"in" needs an array`);
      return expected.includes(actual);
    case 'nin':
      if (!Array.isArray(expected)) throw new InvalidCondition(`"nin" needs an array`);
      return !expected.includes(actual);
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (!Number.isFinite(actual) || !Number.isFinite(expected)) {
        throw new InvalidCondition(`"${op}" needs two finite numbers`);
      }
      if (op === 'lt') return actual < expected;
      if (op === 'lte') return actual <= expected;
      if (op === 'gt') return actual > expected;
      return actual >= expected;
    }
    default:
      throw new InvalidCondition(`unknown operator "${op}"`);
  }
}

export function describeCondition(condition) {
  return `${condition.field} ${condition.op} ${JSON.stringify(condition.value)}`;
}

/* ── Matching one rule ─────────────────────────────────────────────────── */

function matchRule(rule, world, now) {
  if (restrictiveness(rule.outcome) === -1) {
    // Without this check, a rule with a garbage outcome would sit at
    // restrictiveness -1 and could never beat a real rule -- but if it were
    // the ONLY match, it would win, and the engine would return an outcome
    // that is not on the ladder at all.
    return { kind: 'invalid', problem: `unknown outcome "${rule.outcome}"` };
  }

  const matched = [];
  for (const condition of rule.conditions ?? []) {
    const spec = CONDITION_FIELDS[condition?.field];
    if (!spec) return { kind: 'invalid', problem: `unknown field "${condition?.field}"` };
    if (!spec.operators.includes(condition.op)) {
      return { kind: 'invalid', problem: `operator "${condition.op}" not allowed on ${condition.field}` };
    }

    const actual = resolveField(condition.field, world, now);
    if (actual === undefined || actual === null) {
      return { kind: 'incomplete', missing: condition.field };
    }

    let holds;
    try {
      holds = compare(condition.op, actual, condition.value);
    } catch (error) {
      if (error instanceof InvalidCondition) return { kind: 'invalid', problem: error.message };
      throw error;
    }

    // Conditions are AND-ed. OR is two rules -- deliberately, so every rule
    // reads as one sentence a support lead can be held to.
    if (!holds) return { kind: 'no-match' };
    matched.push(describeCondition(condition));
  }

  // A rule with no conditions matches everything for its action type. That is
  // legitimate -- it is how a catch-all baseline rule is expressed.
  return { kind: 'match', matched };
}

/* ── Ordering ──────────────────────────────────────────────────────────── */

/**
 * A TOTAL order over rules, so the decision never depends on the order the
 * database happened to return them in.
 *
 * Priority, then ruleKey, then newest version, then id. The final id
 * tie-break matters for exactly one case: a baseline rule and a tenant rule can
 * share a ruleKey and version, and without it their relative order -- and
 * therefore which one is REPORTED as deciding -- would fall back to input
 * order. The outcome would be the same; the audit record would not.
 *
 * Note that `tenantId` appears nowhere in this file. ADR 0008's layering is
 * safe because of the ladder, not because of a branch on "is this baseline".
 */
function byPrecedence(a, b) {
  return (
    (a.priority ?? 100) - (b.priority ?? 100) ||
    String(a.ruleKey).localeCompare(String(b.ruleKey)) ||
    (b.version ?? 0) - (a.version ?? 0) ||
    String(a._id ?? a.id ?? '').localeCompare(String(b._id ?? b.id ?? ''))
  );
}

/* ── Decisions ─────────────────────────────────────────────────────────── */

function failClosed(reason, detail) {
  return Object.freeze({
    outcome: DEFAULT_OUTCOME,
    ruleId: null,
    ruleKey: null,
    ruleVersion: null,
    matched: Object.freeze([]),
    defaulted: true,
    reason,
    detail: detail ?? null,
    clampedFrom: null,
    // null, not a sentence. The customer-facing text for a fail-closed
    // decision is PolicyBlock's generic fallback, which escalates -- never
    // anything derived from `reason`, which is internal (ADR 0007).
    customerMessage: null,
    internalReason: `Failed closed: ${reason}`,
  });
}

/**
 * Evaluate a proposal against the rules for its action type.
 *
 * PRECEDENCE: EVERY RULE IS EVALUATED, AND THE MOST RESTRICTIVE MATCH WINS.
 *
 * ADR 0004's text says "first match wins" and, separately, "the more
 * restrictive tier wins". Implemented literally, those contradict each other,
 * and the first one is dangerous: a tenant rule with a lower priority number
 * could match first and shadow a baseline `refuse` rule that was never
 * examined -- which is precisely the relaxation ADR 0008 promises cannot
 * happen. So the engine considers every match, takes the most restrictive
 * outcome, and uses priority only to choose WHICH of the equally restrictive
 * rules is reported as the decider.
 */
export function evaluate({ rules, proposal, world, now, allowAutoExecute = false }) {
  if (!proposal?.actionType) {
    throw new TypeError('evaluate() requires a proposal with an actionType');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    // Never `new Date()` inside. A pure function that reads the clock is not
    // pure, and a decision that changes between two identical calls cannot be
    // tested, replayed, or audited.
    throw new TypeError('evaluate() requires an explicit, valid `now`');
  }

  const candidates = (rules ?? [])
    .filter((rule) => rule && rule.active !== false && rule.actionType === proposal.actionType)
    .slice()
    .sort(byPrecedence);

  const matches = [];
  for (const rule of candidates) {
    const verdict = matchRule(rule, world, now);

    if (verdict.kind === 'incomplete') {
      return failClosed('incomplete_world_state', { missing: verdict.missing, ruleKey: rule.ruleKey });
    }
    if (verdict.kind === 'invalid') {
      return failClosed('invalid_rule', { ruleKey: rule.ruleKey, problem: verdict.problem });
    }
    if (verdict.kind === 'match') matches.push({ rule, matched: verdict.matched });
  }

  if (matches.length === 0) {
    // Deny by default. The most important line in the engine: an unmatched
    // proposal means the situation was not anticipated, and an unanticipated
    // situation is exactly when a human should look.
    return failClosed('no_matching_rule');
  }

  // `candidates` is already in precedence order, so the first rule found at
  // the highest restrictiveness is the correct one to report.
  let winner = matches[0];
  for (const candidate of matches) {
    if (restrictiveness(candidate.rule.outcome) > restrictiveness(winner.rule.outcome)) {
      winner = candidate;
    }
  }

  let outcome = winner.rule.outcome;
  let clampedFrom = null;
  if (outcome === 'auto-execute' && !allowAutoExecute) {
    // FR-5.4: auto-execute is modelled and tested, and never selected in the
    // MVP. Shipping an auto-executing path would undercut the invariant this
    // project exists to demonstrate. The clamp is recorded, not hidden, so the
    // audit shows a rule ASKED for auto-execute and was not given it.
    outcome = 'confirm-required';
    clampedFrom = 'auto-execute';
  }

  return Object.freeze({
    outcome,
    ruleId: winner.rule._id ?? winner.rule.id ?? null,
    ruleKey: winner.rule.ruleKey ?? null,
    ruleVersion: winner.rule.version ?? null,
    matched: Object.freeze([...winner.matched]),
    defaulted: false,
    reason: null,
    detail: null,
    clampedFrom,
    customerMessage: winner.rule.customerMessage ?? null,
    internalReason: winner.rule.internalReason ?? null,
  });
}

/** The subset persisted on ActionOutcome.decisionAt* (Phase 3 §4). */
export function toStoredDecision(decision) {
  return {
    ruleId: decision.ruleId,
    ruleKey: decision.ruleKey,
    ruleVersion: decision.ruleVersion,
    outcome: decision.outcome,
    matched: [...decision.matched],
  };
}

export { OUTCOME_LADDER };
