import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESCALATION_REASON,
  REOPENS_ON_ESCALATION,
  automaticEscalationReason,
  planEscalation,
  reopenIsLegal,
} from '../src/tickets/escalation.js';
import { TICKET_STATUS, statusFromEvents } from '../src/domain/ticketState.js';
import { TicketEvent } from '../src/db/models/index.js';

/**
 * ADR 0010. When the system escalates on its own, and what an escalation does
 * to a ticket.
 */

const SYSTEM = { kind: 'system' };
const decision = (outcome, customerMessage = 'A sentence the rule author wrote.') => ({
  outcome,
  ruleKey: 'RULE',
  customerMessage,
});

test('ADR 0010: the automatic cases, outcome by outcome', () => {
  const cases = [
    [{ validity: 'malformed', decision: null }, 'proposal_malformed'],
    [{ validity: 'resolved', decision: decision('agent-only') }, 'policy_agent_only'],
    [{ validity: 'resolved', decision: decision('refuse') }, null],
    [{ validity: 'resolved', decision: decision('refuse', null) }, 'policy_refused'],
    [{ validity: 'resolved', decision: decision('refuse', '   ') }, 'policy_refused'],
    [{ validity: 'resolved', decision: decision('confirm-required') }, null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(automaticEscalationReason(input), expected, JSON.stringify(input));
  }
});

test('FR-8: an agent-only decision always escalates — deny-by-default and fail-closed included', () => {
  // Neither carries a rule, a key or a customer message.
  const denyByDefault = { outcome: 'agent-only', ruleKey: null, reason: 'no_matching_rule' };
  const failClosed = { outcome: 'agent-only', ruleKey: null, reason: 'rules_invalid', customerMessage: '' };
  assert.equal(automaticEscalationReason({ validity: 'resolved', decision: denyByDefault }), 'policy_agent_only');
  assert.equal(automaticEscalationReason({ validity: 'resolved', decision: failClosed }), 'policy_agent_only');
});

test('an outcome this code does not expect escalates: the safe reading is that a person looks', () => {
  for (const outcome of ['auto-execute', 'something-new', undefined]) {
    assert.equal(
      automaticEscalationReason({ validity: 'resolved', decision: { outcome } }),
      'policy_agent_only',
      String(outcome),
    );
  }
});

test('a resolved proposal with no decision is a programming error, not a reason to guess', () => {
  assert.throws(() => automaticEscalationReason({ validity: 'resolved', decision: null }), TypeError);
});

test('ADR 0010: a terminal execution failure escalates, though the decision behind it allowed the action', () => {
  assert.equal(
    automaticEscalationReason({ validity: 'resolved', decision: decision('confirm-required'), outcome: 'failed' }),
    'execution_failed',
  );
});

test('the customer’s own decisions escalate nothing', () => {
  for (const outcome of ['executed', 'rejected_by_customer']) {
    assert.equal(
      automaticEscalationReason({ validity: 'resolved', decision: decision('confirm-required'), outcome }),
      null,
      outcome,
    );
  }
});

test('ADR 0010: the automatic rule never produces a reason only a customer or the advisory tier could give', () => {
  const inputs = [
    { validity: 'malformed', decision: null },
    ...['confirm-required', 'refuse', 'agent-only', 'auto-execute'].flatMap((outcome) => [
      { validity: 'resolved', decision: decision(outcome) },
      { validity: 'resolved', decision: decision(outcome, null) },
    ]),
  ];
  for (const input of inputs) {
    const reason = automaticEscalationReason(input);
    assert.notEqual(reason, ESCALATION_REASON.CUSTOMER_REQUEST);
    assert.notEqual(reason, ESCALATION_REASON.LOW_CONFIDENCE);
  }
});

test('every escalation reason is one TicketEvent accepts, so a plan can never fail validation', () => {
  const accepted = TicketEvent.schema.path('reason').enumValues;
  for (const reason of Object.values(ESCALATION_REASON)) {
    assert.ok(accepted.includes(reason), `TicketEvent.reason does not accept "${reason}"`);
  }
});

test('FR-8.3: with no active ticket, an escalation creates one, open, with its created event at seq 1', () => {
  const plan = planEscalation({ activeTicket: null, reason: 'policy_agent_only', actor: SYSTEM, proposalId: 'p1' });
  assert.deepEqual(plan, {
    kind: 'create',
    ticket: { currentStatus: 'open', reason: 'policy_agent_only', active: true, lastEventSeq: 1 },
    event: {
      seq: 1,
      type: 'created',
      fromStatus: null,
      toStatus: 'open',
      actor: { kind: 'system', userId: null },
      reason: 'policy_agent_only',
      proposalId: 'p1',
    },
  });
});

test('an open or assigned ticket gains an escalated event and keeps its status', () => {
  for (const currentStatus of [TICKET_STATUS.OPEN, TICKET_STATUS.ASSIGNED]) {
    const plan = planEscalation({
      activeTicket: { _id: 't1', currentStatus },
      reason: 'customer_request',
      actor: { kind: 'user', userId: 'u1' },
    });
    assert.equal(plan.kind, 'append', currentStatus);
    assert.equal(plan.expectedStatus, currentStatus);
    assert.equal(plan.toStatus, null);
    assert.deepEqual(plan.event, {
      type: 'escalated',
      fromStatus: null,
      toStatus: null,
      actor: { kind: 'user', userId: 'u1' },
      reason: 'customer_request',
      proposalId: null,
    });
  }
});

test('a waiting or resolved ticket returns to assigned', () => {
  for (const currentStatus of [TICKET_STATUS.WAITING, TICKET_STATUS.RESOLVED]) {
    const plan = planEscalation({ activeTicket: { _id: 't1', currentStatus }, reason: 'policy_agent_only', actor: SYSTEM });
    assert.equal(plan.toStatus, TICKET_STATUS.ASSIGNED, currentStatus);
    assert.equal(plan.event.fromStatus, currentStatus);
    assert.equal(plan.event.toStatus, TICKET_STATUS.ASSIGNED);
  }
});

test('every return to assigned is a legal transition, so this table and the state machine cannot drift apart', () => {
  for (const from of Object.keys(REOPENS_ON_ESCALATION)) {
    assert.ok(reopenIsLegal(from), `${from} → ${REOPENS_ON_ESCALATION[from]} is not legal`);
  }
});

test('a closed ticket is never the active one: being handed one is a programming error', () => {
  assert.throws(
    () => planEscalation({ activeTicket: { _id: 't1', currentStatus: 'closed' }, reason: 'customer_request', actor: SYSTEM }),
    TypeError,
  );
});

test('an unknown reason or a missing actor is refused before anything is planned', () => {
  assert.throws(() => planEscalation({ activeTicket: null, reason: 'felt_like_it', actor: SYSTEM }), TypeError);
  assert.throws(() => planEscalation({ activeTicket: null, reason: 'customer_request' }), TypeError);
});

test('ADR 0006: events from escalation plans rebuild the ticket status', () => {
  const created = planEscalation({ activeTicket: null, reason: 'policy_agent_only', actor: SYSTEM }).event;
  const reopened = planEscalation({
    activeTicket: { _id: 't1', currentStatus: 'resolved' },
    reason: 'customer_request',
    actor: { kind: 'user', userId: 'u1' },
  }).event;
  const events = [
    created,
    { seq: 2, type: 'assigned', fromStatus: 'open', toStatus: 'assigned' },
    { seq: 3, type: 'status_changed', fromStatus: 'assigned', toStatus: 'resolved' },
    { ...reopened, seq: 4 },
  ];
  assert.equal(statusFromEvents(events), 'assigned');
});
