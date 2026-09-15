import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTicketService, parseTicketQuery } from '../src/tickets/ticketService.js';
import { makeMongoTicketRepo } from '../src/tickets/mongoTicketRepo.js';
import { ConcurrentModificationError } from '../src/policy/actionService.js';
import { encodeCursor } from '../src/policy/auditQuery.js';

/**
 * The ticket service, over a fake repository. What is asserted: what a request
 * may ask for, how the repository's answers are translated into statuses, and
 * what each audience is told.
 */

const CTX = { tenantId: 't1' };
const STAFF = { id: 'agent-1', role: 'agent' };
const VALID_ID = '64b7f0c2a1b2c3d4e5f60718';

const TICKET = {
  _id: 'ticket-1',
  tenantId: 't1',
  conversationId: 'conv-1',
  customerId: 'cust-1',
  currentStatus: 'open',
  active: true,
  assigneeId: null,
  reason: 'policy_agent_only',
  priority: 'normal',
  note: 'a private agent note',
  lastEventSeq: 1,
  openedAt: new Date('2026-09-15T09:00:00Z'),
  closedAt: null,
  __v: 0,
};

const DEFAULTS = {
  listTickets: [],
  countByStatus: { open: 1, assigned: 0, waiting: 0, resolved: 0, closed: 0 },
  findTicket: null,
  listEvents: [],
  findConversation: null,
  listMessages: [],
  listAttempts: [],
  findRules: [],
  transition: null,
  findCustomerConversation: null,
  findRefusedProposal: null,
  escalate: { ticketId: 'ticket-1', status: 'open', created: true },
};

function fakeRepo(answers = {}) {
  const calls = [];
  const repo = { calls };
  for (const [name, fallback] of Object.entries(DEFAULTS)) {
    const answer = name in answers ? answers[name] : fallback;
    repo[name] = async (...args) => {
      calls.push({ name, args: args.slice(1) });
      return typeof answer === 'function' ? answer(...args) : answer;
    };
  }
  return repo;
}

const called = (repo, name) => repo.calls.filter((call) => call.name === name);

function rejectsWith(status, kind) {
  return (error) => error.status === status && error.kind === kind;
}

/* ── The queue ────────────────────────────────────────────────────────── */

test('an unknown or invalid queue filter is a 422, and the repository is never asked', async () => {
  for (const query of [{ state: 'open' }, { status: 'archived' }, { limit: '0' }, { limit: '101' }, { limit: '2.5' }, { cursor: 'garbage' }, { status: ['open', 'closed'] }]) {
    const repo = fakeRepo();
    await assert.rejects(makeTicketService({ repo }).list(CTX, query), rejectsWith(422, 'malformed'), JSON.stringify(query));
    assert.equal(called(repo, 'listTickets').length, 0);
  }
});

test('the queue defaults to active tickets, 25 at a time', () => {
  assert.deepEqual(parseTicketQuery({}), { ok: true, value: { status: null, limit: 25, after: null } });
});

test('a valid cursor becomes the row to continue after', () => {
  const openedAt = new Date('2026-09-15T09:00:00Z');
  const parsed = parseTicketQuery({ cursor: encodeCursor({ createdAt: openedAt, id: VALID_ID }) });
  assert.deepEqual(parsed.value.after, { openedAt, id: VALID_ID });
});

test('a page shows no internal bookkeeping, and offers a cursor only when another page exists', async () => {
  const second = { ...TICKET, _id: 'ticket-2', openedAt: new Date('2026-09-15T10:00:00Z') };
  const third = { ...TICKET, _id: 'ticket-3', openedAt: new Date('2026-09-15T11:00:00Z') };
  const repo = fakeRepo({ listTickets: [TICKET, second, third] });

  const result = await makeTicketService({ repo }).list(CTX, { limit: '2' });

  assert.equal(result.tickets.length, 2);
  assert.deepEqual(result.tickets[0], {
    id: 'ticket-1',
    conversationId: 'conv-1',
    customerId: 'cust-1',
    status: 'open',
    active: true,
    assigneeId: null,
    reason: 'policy_agent_only',
    priority: 'normal',
    openedAt: TICKET.openedAt,
    closedAt: null,
    legalMoves: ['assigned'],
  });
  assert.equal(result.page.nextCursor, encodeCursor({ createdAt: second.openedAt, id: 'ticket-2' }));
  assert.deepEqual(result.counts, DEFAULTS.countByStatus);
  assert.deepEqual(called(repo, 'listTickets')[0].args[0], { status: null, after: null, limit: 2 });

  const lastPage = await makeTicketService({ repo: fakeRepo({ listTickets: [TICKET] }) }).list(CTX, {});
  assert.equal(lastPage.page.nextCursor, null);
});

/* ── One ticket ───────────────────────────────────────────────────────── */

test('INV-D: a ticket that is absent, or another tenant’s, is a plain 404', async () => {
  await assert.rejects(makeTicketService({ repo: fakeRepo() }).detail(CTX, 'ticket-9'), rejectsWith(404, 'fault'));
});

test('FR-10.3, ADR 0007: a blocked action is shown with the exact rule version that blocked it, both channels', async () => {
  const at = new Date('2026-09-15T09:00:00Z');
  const attempts = [
    {
      proposal: { _id: 'p1', createdAt: at, validity: 'resolved', actionType: 'order.cancel', target: { orderNumber: '1044' }, confirmText: 'Cancel order 1044', problemCodes: [] },
      outcome: { outcome: 'escalated_at_proposal' },
      decisions: [
        { stage: 'proposal', decision: { ruleId: 'rule-dispatched-v1', ruleKey: 'BASE-CANCEL-DISPATCHED', ruleVersion: 1, outcome: 'agent-only', matched: ['order.status eq "dispatched"'] }, defaulted: false, reason: null },
      ],
    },
    { proposal: { _id: 'p2', createdAt: at, validity: 'malformed', problemCodes: ['missing_target'] }, outcome: null, decisions: [] },
    {
      proposal: { _id: 'p3', createdAt: at, validity: 'resolved', actionType: 'order.cancel', target: { orderNumber: '1043' }, confirmText: 'Cancel order 1043' },
      outcome: null,
      decisions: [{ stage: 'proposal', decision: { ruleId: 'rule-pre-v1', ruleKey: 'BASE-CANCEL-PRE-DISPATCH', ruleVersion: 1, outcome: 'confirm-required', matched: [] } }],
    },
  ];
  const repo = fakeRepo({
    findTicket: TICKET,
    listAttempts: attempts,
    findRules: [{ _id: 'rule-dispatched-v1', internalReason: 'Needs a carrier interception request.', customerMessage: 'A colleague will check with the carrier.' }],
  });

  const { attempts: views, ticket } = await makeTicketService({ repo }).detail(CTX, 'ticket-1');

  assert.deepEqual(called(repo, 'findRules')[0].args[0], ['rule-dispatched-v1', 'rule-pre-v1']);
  assert.equal(ticket.id, 'ticket-1');
  assert.equal('note' in ticket, false);

  const [dispatched, malformed, pending] = views;
  assert.equal(dispatched.kind, 'escalated_at_proposal');
  assert.equal(dispatched.blocked, true);
  assert.deepEqual(dispatched.decisions[0], {
    stage: 'proposal',
    outcome: 'agent-only',
    ruleKey: 'BASE-CANCEL-DISPATCHED',
    ruleVersion: 1,
    matched: ['order.status eq "dispatched"'],
    defaulted: false,
    reason: null,
    internalReason: 'Needs a carrier interception request.',
    customerMessage: 'A colleague will check with the carrier.',
  });
  assert.equal(malformed.kind, 'malformed');
  assert.equal(malformed.blocked, true);
  assert.deepEqual(malformed.problemCodes, ['missing_target']);
  assert.equal(pending.kind, 'pending');
  assert.equal(pending.blocked, false);
  assert.equal(pending.decisions[0].internalReason, null, 'a rule not found reads as unknown, never as another rule');
});

test('a conversation with no attempts asks for no rules', async () => {
  const repo = fakeRepo({ findTicket: TICKET });
  await makeTicketService({ repo }).detail(CTX, 'ticket-1');
  assert.equal(called(repo, 'findRules').length, 0);
});

/* ── Moving a ticket ──────────────────────────────────────────────────── */

test('a status change with no status is a 422 before the repository is asked', async () => {
  for (const to of [undefined, '', 42]) {
    const repo = fakeRepo();
    await assert.rejects(makeTicketService({ repo }).transition(CTX, { ticketId: 'ticket-1', to, user: STAFF }), rejectsWith(422, 'malformed'));
    assert.equal(called(repo, 'transition').length, 0);
  }
});

test('the actor is the signed-in user, and the answer is the ticket as it now is', async () => {
  const repo = fakeRepo({ transition: { ...TICKET, currentStatus: 'assigned', assigneeId: 'agent-1' } });
  const result = await makeTicketService({ repo }).transition(CTX, { ticketId: 'ticket-1', to: 'assigned', user: STAFF, correlationId: 'corr-1' });
  assert.deepEqual(called(repo, 'transition')[0].args[0], {
    ticketId: 'ticket-1',
    to: 'assigned',
    actor: { kind: 'user', userId: 'agent-1' },
    correlationId: 'corr-1',
  });
  assert.equal(result.ticket.status, 'assigned');
  assert.deepEqual(result.ticket.legalMoves, ['waiting', 'resolved']);
});

test('a ticket another agent moved first is a 409 asking for a reload', async () => {
  const repo = fakeRepo({
    transition: () => {
      throw new ConcurrentModificationError();
    },
  });
  await assert.rejects(
    makeTicketService({ repo }).transition(CTX, { ticketId: 'ticket-1', to: 'assigned', user: STAFF }),
    (error) => error.status === 409 && /Reload/.test(error.message),
  );
});

test('a ticket that does not exist in this tenant is a 404', async () => {
  await assert.rejects(
    makeTicketService({ repo: fakeRepo({ transition: null }) }).transition(CTX, { ticketId: 'x', to: 'assigned', user: STAFF }),
    rejectsWith(404, 'fault'),
  );
});

/* ── A customer asking for a person ───────────────────────────────────── */

const ask = (overrides = {}) => ({
  customerId: 'cust-1',
  conversationId: 'conv-1',
  proposalId: null,
  userId: 'user-1',
  correlationId: 'corr-1',
  ...overrides,
});

test('INV-D: someone else’s conversation is a 404, and nothing is escalated', async () => {
  const repo = fakeRepo({ findCustomerConversation: null });
  await assert.rejects(makeTicketService({ repo }).escalateForCustomer(CTX, ask()), rejectsWith(404, 'fault'));
  assert.equal(called(repo, 'escalate').length, 0);
});

test('FR-8.2: a plain request for a person is recorded as the customer’s, and tells them only that one is coming', async () => {
  const repo = fakeRepo({ findCustomerConversation: { _id: 'conv-1' } });
  const result = await makeTicketService({ repo }).escalateForCustomer(CTX, ask());

  assert.equal(called(repo, 'findRefusedProposal').length, 0);
  assert.deepEqual(called(repo, 'escalate')[0].args[0], {
    conversationId: 'conv-1',
    customerId: 'cust-1',
    reason: 'customer_request',
    actor: { kind: 'user', userId: 'user-1' },
    proposalId: null,
    correlationId: 'corr-1',
  });
  assert.deepEqual(result, { escalation: { ticketId: 'ticket-1', status: 'open', created: true } });
});

test('ADR 0010: asking from a refusal the server can see records policy_refused, linked to that proposal', async () => {
  const repo = fakeRepo({ findCustomerConversation: { _id: 'conv-1' }, findRefusedProposal: { _id: 'p1' } });
  await makeTicketService({ repo }).escalateForCustomer(CTX, ask({ proposalId: 'p1' }));

  assert.deepEqual(called(repo, 'findRefusedProposal')[0].args[0], { customerId: 'cust-1', conversationId: 'conv-1', proposalId: 'p1' });
  const [{ args }] = called(repo, 'escalate');
  assert.equal(args[0].reason, 'policy_refused');
  assert.equal(args[0].proposalId, 'p1');
});

test('ADR 0010: a proposal id the server cannot verify as refused is ignored, not believed', async () => {
  const repo = fakeRepo({ findCustomerConversation: { _id: 'conv-1' }, findRefusedProposal: null });
  await makeTicketService({ repo }).escalateForCustomer(CTX, ask({ proposalId: 'someone-elses' }));
  const [{ args }] = called(repo, 'escalate');
  assert.equal(args[0].reason, 'customer_request');
  assert.equal(args[0].proposalId, null);
});

test('the rules that decided attempts are read in policy scope, and invalid ids are dropped', async () => {
  const log = [];
  const repo = makeMongoTicketRepo({
    models: {
      PolicyRule: {
        find: (filter) => {
          log.push(filter);
          return { lean: async () => [] };
        },
      },
    },
    isValidId: (id) => /^[a-f0-9]{24}$/.test(id),
  });

  assert.deepEqual(await repo.findRules(CTX, ['nope']), []);
  assert.equal(log.length, 0);

  await repo.findRules(CTX, [VALID_ID, 'nope']);
  assert.deepEqual(log[0], { _id: { $in: [VALID_ID] }, tenantId: { $in: ['t1', null] } });
});
