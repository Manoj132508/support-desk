import { AppError } from '../errors/AppError.js';
import { ACTION_TYPES, PROBLEM_CODES } from './vocabulary.js';

/**
 * The trust boundary's first gate. ADR 0002, step 1: SHAPE BEFORE SUBSTANCE.
 *
 * A proposal arrives from the AI service, which this system treats as an
 * untrusted caller. Before the policy engine is allowed to reason about what a
 * proposal MEANS, this module decides whether it is even well-formed -- and
 * rejects it, recorded as `malformed`, if not.
 *
 * Doing shape first is what keeps the engine's input space small and totally
 * specified. The engine never has to wonder whether `target` is a string, an
 * array, or a sentence, because nothing that is not exactly the right shape
 * ever reaches it.
 *
 * WHAT "FULLY RESOLVED" MEANS (FR-4.2): a concrete identifier of the right type,
 * no placeholders, no free text for Express to interpret later, and no
 * ambiguity about which record is affected. "The customer's most recent order"
 * is not a target. If the model cannot resolve the target, it must ask the
 * customer -- it may not guess, and a guess arriving here is malformed.
 *
 * PROBLEMS ARE `{ code, message }`. The code is enumerated and goes into the
 * immutable audit row; the message echoes model-supplied text and goes only to
 * the logs. See PROBLEM_CODES in vocabulary.js for why the two are kept apart.
 */

const ALLOWED_TOP_LEVEL = new Set(['actionType', 'target', 'evidence', 'reasonCode']);
const ALLOWED_TARGET = new Set(['kind', 'orderNumber']);
const ALLOWED_EVIDENCE = new Set(['kind', 'ref']);
const EVIDENCE_KINDS = new Set(['kb_chunk', 'tool_result']);

/**
 * Field names through which a caller would be ASSERTING a decision only
 * Express may make. Compared case-insensitively. These get their own problem
 * code, so "the model tried to claim authorisation" is countable in the audit
 * rather than lost among ordinary unexpected fields.
 */
const AUTHORISATION_FIELDS = new Set([
  'authorised',
  'authorized',
  'authorisation',
  'authorization',
  'approved',
  'approval',
  'confirmed',
  'confirmation',
  'confirmtext',
  'execute',
  'executed',
  'tier',
  'outcome',
  'decision',
  'policy',
]);

/** Order numbers as the seed data issues them: short, no spaces, no brackets.
 *  That alone rejects `<orderNumber>`, `{order}` and "the latest order". */
const ORDER_NUMBER = /^[A-Za-z0-9-]{1,32}$/;

/**
 * Words that match the pattern but are obviously not identifiers.
 *
 * A cheap first filter, and deliberately NOT the real protection. The real check
 * is resolution: the order number is looked up scoped to the caller's tenant
 * and customer, and a placeholder that slips past this list simply fails to
 * resolve and is rejected there. This list exists so the common failure --
 * a model filling a slot with "latest" -- is caught with a clearer reason.
 */
const PLACEHOLDERS = new Set([
  'latest',
  'recent',
  'last',
  'current',
  'unknown',
  'none',
  'null',
  'undefined',
  'order',
  'tbd',
  'n-a',
  'na',
  'xxx',
  'placeholder',
]);

const MAX_EVIDENCE = 20;

export const UNRESOLVED_TARGET = 'target_does_not_resolve';

function problem(code, message) {
  if (!PROBLEM_CODES.includes(code)) {
    // A programming error. A code the schema does not accept would make the
    // malformed attempt impossible to record -- the one time recording it
    // matters most -- so an unregistered code fails in tests, not in the audit.
    throw new Error(`Unregistered problem code: ${code}`);
  }
  return { code, message };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a raw proposal. Returns `{ ok, value, problems, codes }` rather than
 * throwing, so the caller can PERSIST the malformed attempt before rejecting it
 * -- what the model tried to do and was stopped from doing is the evidence that
 * INV-A works, and that includes attempts too malformed to evaluate (ADR 0006).
 */
export function validateProposalShape(raw) {
  const problems = [];
  const done = () => ({
    ok: false,
    value: null,
    problems,
    codes: [...new Set(problems.map((p) => p.code))],
  });

  if (!isPlainObject(raw)) {
    problems.push(problem('not_an_object', 'proposal must be an object'));
    return done();
  }

  /*
   * UNKNOWN FIELDS ARE REJECTED, NOT STRIPPED.
   *
   * Stripping would be friendlier and is the wrong call at a trust boundary.
   * A proposal carrying `authorised: true`, `confirmed: true` or `execute: true`
   * is an untrusted caller attempting to assert something only Express may
   * decide. Silently discarding the field would make that attempt invisible;
   * rejecting it makes it an audit record.
   */
  for (const key of Object.keys(raw)) {
    if (ALLOWED_TOP_LEVEL.has(key)) continue;
    if (AUTHORISATION_FIELDS.has(key.toLowerCase())) {
      problems.push(problem('asserted_authorisation', `field "${key}" asserts a decision only the API may make`));
    } else {
      problems.push(problem('unexpected_field', `unexpected field "${key}"`));
    }
  }

  if (!ACTION_TYPES.includes(raw.actionType)) {
    problems.push(problem('unknown_action_type', `unknown actionType ${JSON.stringify(raw.actionType)}`));
  }

  const target = raw.target;
  if (!isPlainObject(target)) {
    problems.push(problem('target_not_an_object', 'target must be an object'));
  } else {
    for (const key of Object.keys(target)) {
      if (!ALLOWED_TARGET.has(key)) {
        problems.push(problem('unexpected_target_field', `unexpected target field "${key}"`));
      }
    }
    if (target.kind !== 'order') {
      problems.push(problem('wrong_target_kind', 'target.kind must be "order"'));
    }

    // A string, exactly. `1043` as a number is rejected rather than coerced:
    // "fully resolved" means the exact identifier in the exact type, and
    // coercion is interpretation, which is the thing this gate refuses to do.
    if (typeof target.orderNumber !== 'string') {
      problems.push(problem('order_number_not_string', 'target.orderNumber must be a string'));
    } else if (!ORDER_NUMBER.test(target.orderNumber)) {
      problems.push(problem('order_number_not_concrete', 'target.orderNumber is not a concrete order number'));
    } else if (PLACEHOLDERS.has(target.orderNumber.toLowerCase())) {
      problems.push(
        problem('order_number_placeholder', `target.orderNumber "${target.orderNumber}" is a placeholder`),
      );
    }
  }

  if (raw.evidence !== undefined) {
    if (!Array.isArray(raw.evidence)) {
      problems.push(problem('evidence_not_an_array', 'evidence must be an array'));
    } else {
      if (raw.evidence.length > MAX_EVIDENCE) {
        problems.push(problem('too_much_evidence', `evidence has more than ${MAX_EVIDENCE} entries`));
      }
      raw.evidence.forEach((item, index) => {
        if (!isPlainObject(item)) {
          problems.push(problem('evidence_not_an_object', `evidence[${index}] must be an object`));
          return;
        }
        for (const key of Object.keys(item)) {
          // `snippet` and `text` land here. Evidence is a REFERENCE, never
          // prose, because prose in an immutable audit row can never be
          // scrubbed (ADR 0006 amendment).
          if (!ALLOWED_EVIDENCE.has(key)) {
            problems.push(problem('unexpected_evidence_field', `evidence[${index}] has unexpected field "${key}"`));
          }
        }
        if (!EVIDENCE_KINDS.has(item.kind)) {
          problems.push(problem('invalid_evidence_kind', `evidence[${index}].kind is invalid`));
        }
        if (typeof item.ref !== 'string' || !item.ref.trim()) {
          problems.push(problem('invalid_evidence_ref', `evidence[${index}].ref must be a non-empty string`));
        }
      });
    }
  }

  if (raw.reasonCode !== undefined && typeof raw.reasonCode !== 'string') {
    problems.push(problem('reason_code_not_string', 'reasonCode must be a string'));
  }

  if (problems.length) return done();

  return {
    ok: true,
    problems: [],
    codes: [],
    value: {
      actionType: raw.actionType,
      target: { kind: 'order', orderNumber: raw.target.orderNumber },
      evidence: (raw.evidence ?? []).map((item) => ({ kind: item.kind, ref: item.ref })),
      reasonCode: raw.reasonCode ?? null,
    },
  };
}

/** Throwing form, for callers that have already persisted the attempt. */
export function assertProposalShape(raw) {
  const result = validateProposalShape(raw);
  if (!result.ok) {
    throw AppError.malformed(`Malformed proposal: ${result.problems.map((p) => p.message).join('; ')}`);
  }
  return result.value;
}

/**
 * Step two of the boundary: does the target actually exist, for this caller?
 *
 * The lookup itself is the caller's job -- `scoped(Order, ctx)` restricted to
 * the customer (ADR 0005) -- so this stays pure. What this function owns is the
 * RULE: a target that does not resolve is malformed, and a target that belongs
 * to someone else is indistinguishable from one that does not exist. The model
 * cannot widen its scope by naming a different order number, because it never
 * supplies the scope.
 *
 * The resolved proposal takes its identifiers FROM THE DATABASE RECORD, not
 * from the model's input. The model said "1043"; what gets carried forward is
 * the order's own `_id` and its own canonical `orderNumber`.
 */
export function resolveTarget(shape, order) {
  if (!order) {
    throw AppError.malformed('Malformed proposal: target does not resolve to an order');
  }
  return {
    ...shape,
    target: {
      kind: 'order',
      orderId: order._id,
      orderNumber: order.orderNumber,
    },
  };
}

/**
 * Money from integer minor units, correctly for the currency.
 *
 * Dividing by 100 is a bug waiting for the first yen order: JPY has no minor
 * unit, so ¥5000 stored as 5000 would render as ¥50.00. Intl knows each
 * currency's fraction digits, so the divisor is derived rather than assumed.
 */
export function formatMoney(minor, currency) {
  const formatter = new Intl.NumberFormat('en-GB', { style: 'currency', currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits;
  return formatter.format(minor / 10 ** digits);
}

function summariseItems(items = []) {
  if (items.length === 0) return 'no items';
  if (items.length === 1) return items[0].name;
  const others = items.length - 1;
  return `${items[0].name} and ${others} more item${others === 1 ? '' : 's'}`;
}

/**
 * The text of the confirmation dialog. FR-6.1: RENDERED FROM THE RECORD, NEVER
 * FROM MODEL OUTPUT.
 *
 * Look at the signature: an action type and an order document. There is no
 * parameter through which model-generated text could reach the customer's
 * confirmation prompt, which is a stronger guarantee than a rule saying it
 * should not. The string returned here is displayed verbatim by
 * ConfirmationDialog and persisted as `confirmedText`, which is how "the
 * customer confirmed exactly this" becomes provable (ADR 0009, property 3).
 *
 * The date is formatted in UTC so the same record always produces the same
 * string -- a confirmation text that varied with the server's time zone could
 * not be compared against what was stored.
 */
export function renderConfirmText(actionType, order) {
  if (actionType !== 'order.cancel') {
    // A programming error, not a data condition: shape validation already
    // limits action types, so reaching here means a caller skipped it.
    throw new TypeError(`No confirmation text defined for ${actionType}`);
  }

  const placed = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(order.placedAt);

  return (
    `Cancel order ${order.orderNumber} — ${summariseItems(order.items)}, ` +
    `${formatMoney(order.totalMinor, order.currency)}, placed ${placed}.`
  );
}
