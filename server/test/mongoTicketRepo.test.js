import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMongoTicketRepo } from '../src/tickets/mongoTicketRepo.js';
import { ConcurrentModificationError } from '../src/policy/actionService.js';

/**
 * The ticket repository, with fake models.
 *
 * Asserted: the tenant in every filter, which writes share a session, the
 * condition each ticket write depends on, where an event's seq comes from, and
 * which lost races are retried. NOT asserted, because it needs a replica set:
 * that MongoDB commits the writes together and enforces the partial unique index.
 */

const CTX = { tenantId: 't1' };
const VALID_ID = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_ID = '64b7f0c2a1b2c3d4e5f60719';
const SYSTEM = { kind: 'system' };
const AGENT = { kind: 'user', userId: 'agent-1' };
const NOW = new Date('2026-09-15T12:00:00Z');

const escalation = {
  conversationId: 'conv-1',
  customerId: 'cust-1',
  reason: 'policy_agent_only',
  actor: SYSTEM,
  proposalId: 'prop-1',
  correlationId: 'corr-1',
};

const duplicateKey = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

function query(resolve, log, op) {
  const chain = {
    session(session) {
      log.push({ op: `${op}.session`, session });
      return chain;
    },
    sort(spec) {
      log.push({ op: `${op}.sort`, spec });
      return chain;
    },
    limit(n) {
      log.push({ op: `${op}.limit`, n });
      return chain;
    },
    lean() {
      return Promise.resolve().then(resolve);
    },
  };
  return chain;
}

function setup({
  active = [],
  updated = [],
  createErrors = [],
  ticket = null,
  proposals = [],
  proposal = null,
  refusal = null,
} = {}) {
  const log = [];
  const sessions = [];
  const take = (queue) => (queue.length ? queue.shift() : null);
  let created = 0;

  const find = (name, rows = []) => (filter) => {
    log.push({ op: `${name}.find`, filter });
    return query(() => rows, log, `${name}.find`);
  };

  const models = {
    Ticket: {
      findOne: (filter) => {
        log.push({ op: 'Ticket.findOne', filter });
        return query(() => ('_id' in filter ? ticket : take(active)), log, 'Ticket.findOne');
      },
      create: async (docs, options) => {
        log.push({ op: 'Ticket.create', docs, options });
        const error = take(createErrors);
        if (error) throw error;
        return docs.map((doc) => {
          const row = { _id: `ticket-${++created}`, ...doc };
          return { ...row, toObject: () => row };
        });
      },
      findOneAndUpdate: (filter, update, options) => {
        log.push({ op: 'Ticket.findOneAndUpdate', filter, update, options });
        return query(() => take(updated), log, 'Ticket.findOneAndUpdate');
      },
      find: find('Ticket'),
      countDocuments: async (filter) => {
        log.push({ op: 'Ticket.countDocuments', filter });
        return 2;
      },
    },
    TicketEvent: {
      create: async (docs, options) => {
        log.push({ op: 'TicketEvent.create', docs, options });
        return docs;
      },
      find: find('TicketEvent'),
    },
    Conversation: {
      updateOne: async (filter, update, options) => {
        log.push({ op: 'Conversation.updateOne', filter, update, options });
        return { modifiedCount: 1 };
      },
      findOne: (filter) => {
        log.push({ op: 'Conversation.findOne', filter });
        return query(() => null, log, 'Conversation.findOne');
      },
    },
    Message: { find: find('Message') },
    ActionProposal: {
      find: find('ActionProposal', proposals),
      findOne: (filter) => {
        log.push({ op: 'ActionProposal.findOne', filter });
        return query(() => proposal, log, 'ActionProposal.findOne');
      },
    },
    ActionOutcome: {
      find: find('ActionOutcome'),
      findOne: (filter) => {
        log.push({ op: 'ActionOutcome.findOne', filter });
        return query(() => refusal, log, 'ActionOutcome.findOne');
      },
    },
    PolicyDecision: { find: find('PolicyDecision') },
  };

  const repo = makeMongoTicketRepo({
    models,
    startSession: async () => {
      const session = {
        ended: false,
        async withTransaction(fn) {
          await fn();
        },
        async endSession() {
          session.ended = true;
        },
      };
      sessions.push(session);
      return session;
    },
    isValidId: (id) => /^[a-f0-9]{24}$/.test(String(id)),
    clock: () => NOW,
  });

  const ops = (name) => log.filter((entry) => entry.op === name);
  return { repo, ops, sessions };
}

/* ── Escalation ───────────────────────────────────────────────────────── */

test('FR-8.3: a first escalation creates the ticket, its event and the conversation link in ONE session', async () => {
  const { repo, ops, sessions } = setup();
  const result = await repo.escalate(CTX, escalation);

  assert.deepEqual(result, { ticketId: 'ticket-1', status: 'open', created: true });
  assert.equal(sessions.length, 1);
  const [session] = sessions;

  assert.deepEqual(ops('Ticket.findOne')[0].filter, { conversationId: 'conv-1', active: true, tenantId: 't1' });
  assert.equal(ops('Ticket.findOne.session')[0].session, session);

  const [create] = ops('Ticket.create');
  assert.deepEqual(create.docs[0], {
    currentStatus: 'open',
    reason: 'policy_agent_only',
    active: true,
    lastEventSeq: 1,
    conversationId: 'conv-1',
    customerId: 'cust-1',
    tenantId: 't1',
  });
  assert.equal(create.options.session, session);

  const [event] = ops('TicketEvent.create');
  assert.deepEqual(event.docs[0], {
    seq: 1,
    type: 'created',
    fromStatus: null,
    toStatus: 'open',
    actor: { kind: 'system', userId: null },
    reason: 'policy_agent_only',
    proposalId: 'prop-1',
    ticketId: 'ticket-1',
    correlationId: 'corr-1',
    tenantId: 't1',
  });
  assert.equal(event.options.session, session);

  const [link] = ops('Conversation.updateOne');
  assert.deepEqual(link.filter, { _id: 'conv-1', tenantId: 't1' });
  assert.deepEqual(link.update, { $set: { status: 'escalated', ticketId: 'ticket-1' } });
  assert.equal(link.options.session, session);
  assert.equal(session.ended, true);
});

test('onto a waiting ticket: back to assigned, conditional on its status, and the event takes the incremented seq', async () => {
  const waiting = { _id: 'ticket-9', currentStatus: 'waiting', lastEventSeq: 4 };
  const { repo, ops } = setup({
    active: [waiting],
    updated: [{ ...waiting, currentStatus: 'assigned', lastEventSeq: 5 }],
  });

  const result = await repo.escalate(CTX, { ...escalation, reason: 'customer_request', actor: { kind: 'user', userId: 'u1' } });

  assert.deepEqual(result, { ticketId: 'ticket-9', status: 'assigned', created: false });
  const [update] = ops('Ticket.findOneAndUpdate');
  assert.deepEqual(update.filter, { _id: 'ticket-9', active: true, currentStatus: 'waiting', tenantId: 't1' });
  assert.deepEqual(update.update, { $inc: { lastEventSeq: 1 }, $set: { currentStatus: 'assigned' } });
  assert.equal(update.options.new, true);
  assert.equal(ops('Ticket.create').length, 0);

  const [event] = ops('TicketEvent.create');
  assert.equal(event.docs[0].seq, 5);
  assert.equal(event.docs[0].type, 'escalated');
  assert.equal(event.docs[0].fromStatus, 'waiting');
  assert.equal(event.docs[0].toStatus, 'assigned');
});

test('onto an open or assigned ticket the update only counts the event', async () => {
  const open = { _id: 'ticket-3', currentStatus: 'open', lastEventSeq: 1 };
  const { repo, ops } = setup({ active: [open], updated: [{ ...open, lastEventSeq: 2 }] });
  await repo.escalate(CTX, escalation);
  assert.deepEqual(ops('Ticket.findOneAndUpdate')[0].update, { $inc: { lastEventSeq: 1 } });
  assert.equal(ops('TicketEvent.create')[0].docs[0].seq, 2);
});

test('two first escalations racing: the loser’s duplicate key is retried once, and appends to the winner’s ticket', async () => {
  const winner = { _id: 'ticket-7', currentStatus: 'open', lastEventSeq: 1 };
  const { repo, ops, sessions } = setup({
    active: [null, winner],
    createErrors: [duplicateKey()],
    updated: [{ ...winner, lastEventSeq: 2 }],
  });

  const result = await repo.escalate(CTX, escalation);

  assert.deepEqual(result, { ticketId: 'ticket-7', status: 'open', created: false });
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((session) => session.ended));
  assert.equal(ops('TicketEvent.create').length, 1);
});

test('a ticket that moves under an escalation is retried once; losing twice is reported', async () => {
  const open = { _id: 'ticket-3', currentStatus: 'open', lastEventSeq: 1 };
  const { repo, sessions } = setup({ active: [open, open], updated: [null, null] });
  await assert.rejects(repo.escalate(CTX, escalation), ConcurrentModificationError);
  assert.equal(sessions.length, 2);
});

test('any other failure is not retried, and the session still ends', async () => {
  const { repo, sessions } = setup({ createErrors: [new Error('not primary')] });
  await assert.rejects(repo.escalate(CTX, escalation), /not primary/);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].ended, true);
});

test('ADR 0010: applyEscalation writes in the CALLER’s session and never opens its own', async () => {
  const { repo, ops, sessions } = setup();
  const callers = { name: 'the outcome transaction' };

  await repo.applyEscalation(CTX, escalation, callers);

  assert.equal(sessions.length, 0);
  assert.equal(ops('Ticket.findOne.session')[0].session, callers);
  for (const write of [...ops('Ticket.create'), ...ops('TicketEvent.create'), ...ops('Conversation.updateOne')]) {
    assert.equal(write.options.session, callers, write.op);
  }
});

/* ── Transitions ──────────────────────────────────────────────────────── */

test('INV-D: a malformed ticket id is not found, without a query or a session', async () => {
  const { repo, ops, sessions } = setup();
  assert.equal(await repo.transition(CTX, { ticketId: 'nope', to: 'assigned', actor: AGENT }), null);
  assert.equal(ops('Ticket.findOne').length, 0);
  assert.equal(sessions.length, 0);
});

test('a ticket absent from this tenant is not found, and nothing is written', async () => {
  const { repo, ops } = setup({ ticket: null });
  assert.equal(await repo.transition(CTX, { ticketId: VALID_ID, to: 'assigned', actor: AGENT }), null);
  assert.deepEqual(ops('Ticket.findOne')[0].filter, { _id: VALID_ID, tenantId: 't1' });
  assert.equal(ops('Ticket.findOneAndUpdate').length, 0);
  assert.equal(ops('TicketEvent.create').length, 0);
});

test('FR-9.2: an illegal move is refused and writes nothing', async () => {
  const { repo, ops } = setup({ ticket: { _id: VALID_ID, currentStatus: 'open', lastEventSeq: 1 } });
  await assert.rejects(
    repo.transition(CTX, { ticketId: VALID_ID, to: 'closed', actor: AGENT }),
    (error) => error.kind === 'malformed',
  );
  assert.equal(ops('Ticket.findOneAndUpdate').length, 0);
  assert.equal(ops('TicketEvent.create').length, 0);
});

test('a legal move is conditional on the status it was planned from, and its event takes the counted seq', async () => {
  const before = { _id: VALID_ID, currentStatus: 'open', lastEventSeq: 1 };
  const after = { ...before, currentStatus: 'assigned', assigneeId: 'agent-1', lastEventSeq: 2 };
  const { repo, ops, sessions } = setup({ ticket: before, updated: [after] });

  const result = await repo.transition(CTX, { ticketId: VALID_ID, to: 'assigned', actor: AGENT, correlationId: 'corr-2' });

  assert.equal(result, after);
  const [session] = sessions;
  const [update] = ops('Ticket.findOneAndUpdate');
  assert.deepEqual(update.filter, { _id: VALID_ID, currentStatus: 'open', tenantId: 't1' });
  assert.deepEqual(update.update, { $set: { currentStatus: 'assigned', assigneeId: 'agent-1' }, $inc: { lastEventSeq: 1 } });
  assert.equal(update.options.session, session);
  assert.equal(ops('Ticket.findOne.session')[0].session, session);

  const [event] = ops('TicketEvent.create');
  assert.deepEqual(event.docs[0], {
    type: 'assigned',
    fromStatus: 'open',
    toStatus: 'assigned',
    actor: { kind: 'user', userId: 'agent-1' },
    reason: 'agent_action',
    ticketId: VALID_ID,
    seq: 2,
    correlationId: 'corr-2',
    tenantId: 't1',
  });
  assert.equal(event.options.session, session);
});

test('two agents moving one ticket: the second write matches nothing, and is reported rather than retried', async () => {
  const { repo, ops, sessions } = setup({ ticket: { _id: VALID_ID, currentStatus: 'open', lastEventSeq: 1 }, updated: [null] });
  await assert.rejects(repo.transition(CTX, { ticketId: VALID_ID, to: 'assigned', actor: AGENT }), ConcurrentModificationError);
  assert.equal(sessions.length, 1);
  assert.equal(ops('TicketEvent.create').length, 0);
});

test('closing uses the injected clock', async () => {
  const resolved = { _id: VALID_ID, currentStatus: 'resolved', lastEventSeq: 3 };
  const { repo, ops } = setup({ ticket: resolved, updated: [{ ...resolved, currentStatus: 'closed', lastEventSeq: 4 }] });
  await repo.transition(CTX, { ticketId: VALID_ID, to: 'closed', actor: AGENT });
  assert.deepEqual(ops('Ticket.findOneAndUpdate')[0].update.$set, { currentStatus: 'closed', active: false, closedAt: NOW });
});

/* ── Reading ──────────────────────────────────────────────────────────── */

test('FR-10.1: the default queue is every active ticket, oldest first, with one extra row for paging', async () => {
  const { repo, ops } = setup();
  await repo.listTickets(CTX, { limit: 25 });
  assert.deepEqual(ops('Ticket.find')[0].filter, { active: true, tenantId: 't1' });
  assert.deepEqual(ops('Ticket.find.sort')[0].spec, { openedAt: 1, _id: 1 });
  assert.equal(ops('Ticket.find.limit')[0].n, 26);
});

test('a status filter replaces the active filter', async () => {
  const { repo, ops } = setup();
  await repo.listTickets(CTX, { status: 'closed', limit: 25 });
  assert.deepEqual(ops('Ticket.find')[0].filter, { currentStatus: 'closed', tenantId: 't1' });
});

test('a cursor continues strictly after the last row, and cannot remove the tenant', async () => {
  const { repo, ops } = setup();
  const openedAt = new Date('2026-09-15T09:00:00Z');
  await repo.listTickets(CTX, { after: { openedAt, id: VALID_ID }, limit: 25 });
  assert.deepEqual(ops('Ticket.find')[0].filter, {
    active: true,
    tenantId: 't1',
    $or: [{ openedAt: { $gt: openedAt } }, { openedAt, _id: { $gt: VALID_ID } }],
  });
});

test('counts cover every status, each within the tenant', async () => {
  const { repo, ops } = setup();
  const counts = await repo.countByStatus(CTX);
  assert.deepEqual(counts, { open: 2, assigned: 2, waiting: 2, resolved: 2, closed: 2 });
  assert.ok(ops('Ticket.countDocuments').every(({ filter }) => filter.tenantId === 't1'));
});

test('a ticket’s events are read in seq order, within the tenant', async () => {
  const { repo, ops } = setup();
  await repo.listEvents(CTX, VALID_ID);
  assert.deepEqual(ops('TicketEvent.find')[0].filter, { ticketId: VALID_ID, tenantId: 't1' });
  assert.deepEqual(ops('TicketEvent.find.sort')[0].spec, { seq: 1 });
});

test('a conversation with no attempts makes no further queries', async () => {
  const { repo, ops } = setup({ proposals: [] });
  assert.deepEqual(await repo.listAttempts(CTX, 'conv-1'), []);
  assert.equal(ops('ActionOutcome.find').length, 0);
  assert.equal(ops('PolicyDecision.find').length, 0);
});

test('attempts are joined to their outcome and decisions by proposal, within the tenant', async () => {
  const { repo, ops } = setup({ proposals: [{ _id: VALID_ID }, { _id: OTHER_ID }] });
  const attempts = await repo.listAttempts(CTX, 'conv-1');
  assert.equal(attempts.length, 2);
  assert.deepEqual(ops('ActionOutcome.find')[0].filter, { proposalId: { $in: [VALID_ID, OTHER_ID] }, tenantId: 't1' });
  assert.deepEqual(ops('PolicyDecision.find')[0].filter, { proposalId: { $in: [VALID_ID, OTHER_ID] }, tenantId: 't1' });
});

/* ── Verifying a refusal a customer escalates from ────────────────────── */

test('ADR 0010: a refusal is looked for only within this tenant, customer AND conversation', async () => {
  const { repo, ops } = setup({ proposal: { _id: VALID_ID }, refusal: { outcome: 'refused_at_proposal' } });
  const found = await repo.findRefusedProposal(CTX, { customerId: 'cust-1', conversationId: 'conv-1', proposalId: VALID_ID });
  assert.deepEqual(found, { _id: VALID_ID });
  assert.deepEqual(ops('ActionProposal.findOne')[0].filter, {
    _id: VALID_ID,
    customerId: 'cust-1',
    conversationId: 'conv-1',
    tenantId: 't1',
  });
  assert.deepEqual(ops('ActionOutcome.findOne')[0].filter, {
    proposalId: VALID_ID,
    outcome: { $in: ['refused_at_proposal', 'refused_at_execution'] },
    tenantId: 't1',
  });
});

test('a proposal that was not refused, or a malformed id, is no refusal', async () => {
  const notRefused = setup({ proposal: { _id: VALID_ID }, refusal: null });
  assert.equal(
    await notRefused.repo.findRefusedProposal(CTX, { customerId: 'cust-1', conversationId: 'conv-1', proposalId: VALID_ID }),
    null,
  );

  const malformed = setup();
  assert.equal(
    await malformed.repo.findRefusedProposal(CTX, { customerId: 'cust-1', conversationId: 'conv-1', proposalId: 'x' }),
    null,
  );
  assert.equal(malformed.ops('ActionProposal.findOne').length, 0);
});
