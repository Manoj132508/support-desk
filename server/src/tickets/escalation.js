import { TICKET_STATUS, canTransition } from '../domain/ticketState.js';

/**
 * When a conversation reaches a person, and what that does to its ticket.
 * FR-8, ADR 0010.
 *
 * Two pure functions, for the same reason the policy engine is pure:
 *
 *   automaticEscalationReason  ADR 0010's table. Given what the deterministic
 *                              path recorded, does the system escalate on its
 *                              own, and why?
 *   planEscalation             Given the conversation's active ticket, if any,
 *                              what to write: a new ticket, or an event on the
 *                              existing one.
 *
 * Neither touches a database. The repository applies a plan inside the same
 * transaction as the record that caused it.
 */

export const ESCALATION_REASON = Object.freeze({
  POLICY_AGENT_ONLY: 'policy_agent_only',
  POLICY_REFUSED: 'policy_refused',
  PROPOSAL_MALFORMED: 'proposal_malformed',
  EXECUTION_FAILED: 'execution_failed',
  LOW_CONFIDENCE: 'low_confidence',
  CUSTOMER_REQUEST: 'customer_request',
});

const REASONS = new Set(Object.values(ESCALATION_REASON));

const hasText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * ADR 0010's automatic cases. Returns the reason the system escalates on its
 * own, or null when it does not.
 *
 * Only the deterministic tier's records are inputs. There is deliberately no
 * parameter for the AI service's `shouldEscalate`: the advisory tier can offer
 * a customer a person, never create a ticket.
 */
export function automaticEscalationReason({ validity, decision, outcome = null }) {
  // Nothing was decided at all. A person has to look.
  if (validity === 'malformed') return ESCALATION_REASON.PROPOSAL_MALFORMED;

  // A fault recorded as a terminal failure: the action did not happen and the
  // customer can no longer retry. Checked before the decision, which at this
  // point allowed the action -- execution was under way.
  if (outcome === 'failed') return ESCALATION_REASON.EXECUTION_FAILED;

  if (!decision) {
    // Every resolved proposal is evaluated before this question is asked. A
    // missing decision is a bug in the caller, and guessing would hide it.
    throw new TypeError('automaticEscalationReason needs the decision for a resolved proposal');
  }

  switch (decision.outcome) {
    case 'confirm-required':
      // The customer decides, in the confirmation dialog.
      return null;
    case 'refuse':
      // A rule that explains itself has answered the customer, who may still
      // ask for a person. One that does not falls back to ADR 0007's text,
      // which promises a colleague -- so the promise is kept here.
      return hasText(decision.customerMessage) ? null : ESCALATION_REASON.POLICY_REFUSED;
    case 'agent-only':
      return ESCALATION_REASON.POLICY_AGENT_ONLY;
    default:
      // An outcome this code does not expect. The engine clamps auto-execute,
      // so this should be unreachable; if it is reached, the safe reading is
      // "a person looks", the same reading the action service takes.
      return ESCALATION_REASON.POLICY_AGENT_ONLY;
  }
}

/**
 * Escalating onto a ticket that had left someone's attention brings it back.
 * `waiting` means waiting on the customer, and the customer is here; `resolved`
 * means someone thought it was done, and it is not.
 */
export const REOPENS_ON_ESCALATION = Object.freeze({
  [TICKET_STATUS.WAITING]: TICKET_STATUS.ASSIGNED,
  [TICKET_STATUS.RESOLVED]: TICKET_STATUS.ASSIGNED,
});

const ACTOR_KINDS = new Set(['system', 'user', 'assistant']);

/**
 * What an escalation writes. FR-8.3: "creates or updates a ticket".
 *
 * `activeTicket` is the conversation's one active ticket, or null. At most one
 * exists, which the database enforces with a partial unique index; this
 * function only decides what to do with the one it is given.
 *
 * The event's `seq` is fixed here only for a new ticket, where it is 1. On an
 * existing ticket the repository takes it from the ticket's own counter as it
 * writes, so two writers cannot pick the same number.
 */
export function planEscalation({ activeTicket, reason, actor, proposalId = null }) {
  if (!REASONS.has(reason)) throw new TypeError(`Unknown escalation reason: ${reason}`);
  if (!ACTOR_KINDS.has(actor?.kind)) throw new TypeError('An escalation needs an actor');

  const eventActor = { kind: actor.kind, userId: actor.userId ?? null };

  if (!activeTicket) {
    return {
      kind: 'create',
      ticket: { currentStatus: TICKET_STATUS.OPEN, reason, active: true, lastEventSeq: 1 },
      event: {
        seq: 1,
        type: 'created',
        fromStatus: null,
        toStatus: TICKET_STATUS.OPEN,
        actor: eventActor,
        reason,
        proposalId,
      },
    };
  }

  if (activeTicket.currentStatus === TICKET_STATUS.CLOSED) {
    // Closing a ticket retires it, so a closed ticket is never the active one.
    // Being handed one means the caller's query is wrong.
    throw new TypeError('A closed ticket cannot be the active ticket');
  }

  const toStatus = REOPENS_ON_ESCALATION[activeTicket.currentStatus] ?? null;

  return {
    kind: 'append',
    ticketId: activeTicket._id,
    expectedStatus: activeTicket.currentStatus,
    toStatus,
    event: {
      type: 'escalated',
      fromStatus: toStatus ? activeTicket.currentStatus : null,
      toStatus,
      actor: eventActor,
      reason,
      proposalId,
    },
  };
}

/** Exported for the test that keeps this table and the state machine in step. */
export function reopenIsLegal(from) {
  return canTransition(from, REOPENS_ON_ESCALATION[from]);
}
