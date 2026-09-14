/**
 * The policy engine's entire vocabulary, with NO imports.
 *
 * This file exists so the engine can be pure in the strictest sense. The
 * ladder and the condition registry were first declared in
 * `db/models/audit.js`, next to the schema that validates rules on save --
 * but importing from there pulls in Mongoose and registers every audit model
 * as a side effect. ADR 0004 promises "the engine module imports nothing that
 * performs I/O", and a module that drags a database driver in behind it only
 * keeps that promise by accident.
 *
 * So the vocabulary lives here, imports nothing, and the schema imports it
 * from here. One definition, two consumers, and the pure one does not depend
 * on the impure one.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Most permissive first. The ORDER IS THE PRECEDENCE RULE: when rules
 * conflict, the outcome further right wins. That single fact is what makes
 * ADR 0008's baseline layering safe with no branch in the engine -- a tenant
 * rule can only ever move a decision further right, never back left past a
 * platform rule.
 */
export const OUTCOME_LADDER = deepFreeze([
  'auto-execute',
  'confirm-required',
  'agent-only',
  'refuse',
]);

/** Deny by default resolves here: an unanticipated situation warrants a
 *  human, not a refusal and not an execution (ADR 0004). */
export const DEFAULT_OUTCOME = 'agent-only';

/**
 * The closed condition registry (Phase 3 §5.2). Every field the engine can
 * reason about, its type, and the operators that type permits. A rule naming
 * anything outside this list is rejected when saved, and -- because
 * rejection-on-save is a promise about the past, not the present -- is also
 * failed closed if it somehow reaches evaluation.
 */
export const CONDITION_FIELDS = deepFreeze({
  'order.status': {
    type: 'enum',
    operators: ['eq', 'ne', 'in', 'nin'],
    values: ['placed', 'paid', 'packed', 'dispatched', 'delivered', 'cancelled'],
  },
  'order.ageHours': { type: 'int', operators: ['lt', 'lte', 'gt', 'gte'] },
  'order.totalMinor': { type: 'int', operators: ['lt', 'lte', 'gt', 'gte'] },
  'order.currency': { type: 'enum', operators: ['eq', 'in'], values: null },
  'customer.orderCount90d': { type: 'int', operators: ['lt', 'lte', 'gt', 'gte'] },
});

export const ACTION_TYPES = deepFreeze(['order.cancel']);

/**
 * Why a proposal was malformed, as CODES.
 *
 * A malformed proposal is still recorded (FR-4.3), in a row that can never be
 * edited. The human-readable problem messages echo model-supplied text -- an
 * unknown field name, a placeholder order number -- so storing them would put
 * free text into an immutable row, which is unscrubbable by construction (the
 * constraint behind ADR 0006's amendment). The audit stores these codes; the
 * messages go to the logs, which rotate.
 *
 * `asserted_authorisation` is separate from `unexpected_field` on purpose. "The
 * model tried to claim a proposal was already authorised" is exactly the kind
 * of attempt the audit exists to surface, and it should be countable on its own
 * rather than buried among typos.
 */
export const PROBLEM_CODES = deepFreeze([
  'not_an_object',
  'asserted_authorisation',
  'unexpected_field',
  'unknown_action_type',
  'target_not_an_object',
  'unexpected_target_field',
  'wrong_target_kind',
  'order_number_not_string',
  'order_number_not_concrete',
  'order_number_placeholder',
  'evidence_not_an_array',
  'too_much_evidence',
  'evidence_not_an_object',
  'unexpected_evidence_field',
  'invalid_evidence_kind',
  'invalid_evidence_ref',
  'reason_code_not_string',
  'target_does_not_resolve',
]);

/** Position on the ladder; -1 for anything that is not a real outcome. */
export function restrictiveness(outcome) {
  return OUTCOME_LADDER.indexOf(outcome);
}
