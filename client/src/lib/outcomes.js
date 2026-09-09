/**
 * The vocabulary the whole client shares.
 *
 * These constants are not "magic string tidying". They are the client's copy
 * of two things the design phases decided, and keeping them in one file is
 * what stops a component from inventing a fifth error kind or forgetting that
 * a refusal is not a failure.
 */

/* ── The four error kinds (Phase 2 section 5) ────────────────────────────
 *
 * Three of these are NORMAL OUTCOMES OF A WORKING SYSTEM. Only `fault` is a
 * bug. `isPolicyKind` exists so a component can ask the question directly
 * rather than each caller re-deriving it -- and getting it wrong once is all
 * it takes to render a refusal as a red error toast.
 */
export const ERROR_KIND = {
  MALFORMED: 'malformed',
  REFUSED: 'refused',
  STALE: 'stale',
  FAULT: 'fault',
};

const POLICY_KINDS = new Set([
  ERROR_KIND.MALFORMED,
  ERROR_KIND.REFUSED,
  ERROR_KIND.STALE,
]);

export function isPolicyKind(kind) {
  return POLICY_KINDS.has(kind);
}

/* ── The seven terminal outcomes (Phase 3 section 4) ─────────────────── */
export const OUTCOME = {
  REFUSED_AT_PROPOSAL: 'refused_at_proposal',
  ESCALATED_AT_PROPOSAL: 'escalated_at_proposal',
  REJECTED_BY_CUSTOMER: 'rejected_by_customer',
  EXPIRED: 'expired',
  REFUSED_AT_EXECUTION: 'refused_at_execution',
  EXECUTED: 'executed',
  FAILED: 'failed',
};

/** Exactly one outcome represents a mutation. Worth being able to ask. */
export function didMutate(outcome) {
  return outcome === OUTCOME.EXECUTED;
}

export const OUTCOME_LABEL = {
  [OUTCOME.REFUSED_AT_PROPOSAL]: 'Refused by policy',
  [OUTCOME.ESCALATED_AT_PROPOSAL]: 'Escalated to an agent',
  [OUTCOME.REJECTED_BY_CUSTOMER]: 'Declined by customer',
  [OUTCOME.EXPIRED]: 'Expired undecided',
  [OUTCOME.REFUSED_AT_EXECUTION]: 'Refused at execution',
  [OUTCOME.EXECUTED]: 'Executed',
  [OUTCOME.FAILED]: 'Failed',
};

/* ── The policy outcome ladder (ADR 0004, as amended in Phase 3) ──────────
 *
 * Ordered MOST PERMISSIVE FIRST. The order is load-bearing, not cosmetic:
 * "more restrictive wins" is implemented as "higher index wins", which is what
 * lets ADR 0008 layer tenant rules over a platform baseline safely without a
 * single branch in the engine -- a tenant rule can only ever move an outcome
 * further right.
 *
 * The client does not evaluate policy (that is the server's job and the whole
 * point of INV-A). It holds the ladder only to LABEL decisions correctly.
 */
export const TIER_LADDER = [
  'auto-execute',
  'confirm-required',
  'agent-only',
  'refuse',
];

export const TIER_DESCRIPTION = {
  'auto-execute': 'The assistant may do this without asking',
  'confirm-required': 'The assistant may do this once the customer confirms',
  'agent-only': 'A human agent may do this; the assistant may not',
  refuse: 'This must not happen through the support desk',
};

/** Used by the rule editor and by tests asserting precedence is understood. */
export function mostRestrictive(a, b) {
  return TIER_LADDER.indexOf(a) >= TIER_LADDER.indexOf(b) ? a : b;
}
