import { AppError } from '../errors/AppError.js';

/**
 * The ticket state machine. FR-9.
 *
 * A pure module with no I/O, for the same reason the policy engine is pure
 * (NFR-6): the thing that decides whether a change is legal must be testable
 * exhaustively, and anything that needs a database to answer will be tested
 * less than it deserves.
 *
 * The transitions are declared as data rather than as a chain of ifs, so
 * "which moves are legal" is answerable by reading one object instead of
 * tracing branches.
 */

export const TICKET_STATUS = {
  OPEN: 'open',
  ASSIGNED: 'assigned',
  WAITING: 'waiting',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
};

export const LEGAL_TRANSITIONS = {
  [TICKET_STATUS.OPEN]: [TICKET_STATUS.ASSIGNED],
  [TICKET_STATUS.ASSIGNED]: [TICKET_STATUS.WAITING, TICKET_STATUS.RESOLVED],
  [TICKET_STATUS.WAITING]: [TICKET_STATUS.ASSIGNED, TICKET_STATUS.RESOLVED],
  // Reopening is legal: a customer replying to a resolved ticket should not
  // need a new one, which would scatter one problem across two histories.
  [TICKET_STATUS.RESOLVED]: [TICKET_STATUS.CLOSED, TICKET_STATUS.ASSIGNED],
  // Terminal. Deliberately so -- a closed ticket is a settled record, and
  // allowing edits to it would make "closed" mean nothing.
  [TICKET_STATUS.CLOSED]: [],
};

export function canTransition(from, to) {
  return (LEGAL_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Throws `malformed` (422), NOT `refused` (403).
 *
 * No policy rule declined this -- the request simply was not a valid move in
 * the machine. Keeping the two apart matters: `refused` renders in the policy
 * language and belongs in the policy audit, so classifying a state-machine bug
 * as a refusal would put non-decisions into the record that exists to
 * demonstrate INV-A.
 */
export function assertTransition(from, to) {
  if (!Object.hasOwn(LEGAL_TRANSITIONS, to)) {
    throw AppError.malformed(`Unknown ticket status: ${to}`);
  }
  if (!canTransition(from, to)) {
    throw AppError.malformed(
      `Illegal ticket transition: ${from} → ${to}. ` +
        `Legal from ${from}: ${LEGAL_TRANSITIONS[from].join(', ') || 'none (terminal)'}`,
    );
  }
}

/**
 * Rebuild `currentStatus` from the event stream.
 *
 * `Ticket.currentStatus` is a denormalised cache so the agent queue is one
 * indexed query rather than an aggregation. The events are the source of
 * truth, and this function is what makes that claim checkable rather than
 * aspirational -- a test rebuilds and compares (ADR 0006).
 */
export function statusFromEvents(events) {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  let status = null;
  for (const event of ordered) {
    if (event.type === 'created') status = TICKET_STATUS.OPEN;
    else if (event.toStatus) status = event.toStatus;
  }
  return status;
}

/**
 * Plan a manual transition: what to write, and the event that records it.
 *
 * Pure, like the rest of this module. The repository applies the plan
 * conditionally on `expectedStatus`, so two agents moving the same ticket at
 * the same moment cannot both succeed from the same starting state.
 *
 * Moving a ticket to `assigned` assigns it to whoever moved it. Assigning a
 * ticket to someone else is not part of the MVP.
 */
export function planTransition({ ticket, to, actor, now }) {
  // Checked first: a missing actor is a bug in the caller, and should not be
  // reported as the user's bad request.
  if (actor?.kind !== 'user' || !actor.userId) {
    throw new TypeError('A manual ticket transition needs a user actor');
  }
  assertTransition(ticket.currentStatus, to);

  const set = { currentStatus: to };
  if (to === TICKET_STATUS.ASSIGNED) set.assigneeId = actor.userId;
  if (to === TICKET_STATUS.CLOSED) {
    // No longer the conversation's active ticket, so a later escalation opens a
    // new one rather than reviving a settled record (ADR 0010).
    set.active = false;
    set.closedAt = now;
  }

  return {
    expectedStatus: ticket.currentStatus,
    set,
    event: {
      type: to === TICKET_STATUS.ASSIGNED ? 'assigned' : 'status_changed',
      fromStatus: ticket.currentStatus,
      toStatus: to,
      actor: { kind: 'user', userId: actor.userId },
      reason: 'agent_action',
    },
  };
}
