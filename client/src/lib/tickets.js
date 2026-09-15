import { OUTCOME_LABEL } from './outcomes.js';

/**
 * The ticket vocabulary the console shares. LABELS ONLY.
 *
 * Which moves are legal is decided by the server's state machine and arrives
 * with each ticket as `legalMoves`, so the console never re-derives it. The UI
 * narrowing the options is convenience; the server rejecting anything else is
 * the enforcement (FR-9.2, Phase 4 §6).
 */

export const STATUS_ORDER = ['open', 'assigned', 'waiting', 'resolved', 'closed'];

/** Everything still being worked -- the queue's default view. */
export const ACTIVE_STATUSES = ['open', 'assigned', 'waiting', 'resolved'];

export const STATUS_LABEL = {
  open: 'Open',
  assigned: 'Assigned',
  waiting: 'Waiting on customer',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const STATUS_TONE = {
  open: 'accent',
  assigned: 'neutral',
  waiting: 'neutral',
  resolved: 'success',
  closed: 'neutral',
};

/** Why a ticket is in the queue (ADR 0010's recorded reasons). */
export const REASON_LABEL = {
  policy_agent_only: 'Policy needs a person',
  policy_refused: 'Refused by policy',
  proposal_malformed: 'Request could not be understood',
  execution_failed: 'Action failed',
  low_confidence: 'No answer found',
  customer_request: 'Customer asked for a person',
  agent_action: 'Agent action',
  sla_breach: 'Response time exceeded',
};

/** A move is named by where it goes AND where it comes from: taking an open
 *  ticket and reopening a resolved one both go to `assigned`. */
export function moveLabel(from, to) {
  if (to === 'assigned') {
    if (from === 'open') return 'Take ticket';
    if (from === 'resolved') return 'Reopen';
    return 'Resume';
  }
  if (to === 'waiting') return 'Wait for customer';
  if (to === 'resolved') return 'Mark resolved';
  if (to === 'closed') return 'Close ticket';
  return STATUS_LABEL[to] ?? to;
}

const statusName = (status) => STATUS_LABEL[status] ?? status;

export function eventLabel(event) {
  switch (event.type) {
    case 'created':
      return 'Ticket opened';
    case 'assigned':
      return event.fromStatus === 'open' ? 'Taken' : `${statusName(event.fromStatus)} → Assigned`;
    case 'status_changed':
      return `${statusName(event.fromStatus)} → ${statusName(event.toStatus)}`;
    case 'escalated':
      return event.toStatus
        ? `Escalated again · ${statusName(event.fromStatus)} → ${statusName(event.toStatus)}`
        : 'Escalated again';
    case 'note':
      return 'Note';
    default:
      return event.type;
  }
}

export const ROLE_LABEL = {
  customer: 'Customer',
  assistant: 'Assistant',
  agent: 'Agent',
  system: 'System',
};

/** An attempt's kind: the seven outcomes, plus the two states that have none. */
export const ATTEMPT_KIND_LABEL = {
  ...OUTCOME_LABEL,
  malformed: 'Could not be understood',
  pending: 'Awaiting the customer',
};

export function formatWhen(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Enough of an id to tell tickets apart on screen. */
export const shortId = (id) => (typeof id === 'string' ? id.slice(-6) : '');
