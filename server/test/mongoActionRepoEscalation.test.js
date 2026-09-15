import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMongoActionRepo } from '../src/policy/mongoActionRepo.js';

/**
 * ADR 0010 in the action repository: a proposal or outcome that escalates is
 * written in the same transaction as its ticket.
 *
 * Fake models and a fake ticket repository. Asserted: which writes share a
 * session, and how each lost race resolves. NOT asserted, because it needs a
 * replica set: that an aborted transaction really leaves no outcome behind.
 */

const CTX = { tenantId: 't1' };
const duplicateKey = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

const outcomeDoc = {
  proposalId: 'prop-1',
  outcome: 'escalated_at_proposal',
  decisionAtProposal: { ruleKey: 'BASE-CANCEL-DISPATCHED', outcome: 'agent-only' },
  decisionAtExecution: null,
  idempotencyKey: 'proposal:prop-1',
};

const escalation = {
  conversationId: 'conv-1',
  customerId: 'cust-1',
  reason: 'policy_agent_only',
  actor: { kind: 'system' },
  correlationId: 'corr-1',
};

function setup({ createErrors = [], ticketErrors = [], existingOutcome = null } = {}) {
  const log = [];
  const sessions = [];
  const take = (queue) => (queue.length ? queue.shift() : null);
  let ids = 0;

  const creator = (name) => async (docs, options) => {
    log.push({ op: `${name}.create`, docs, options });
    const error = take(createErrors);
    if (error) throw error;
    return docs.map((doc) => {
      const row = { _id: `${name}-${++ids}`, ...doc };
      return { ...row, toObject: () => row };
    });
  };

  const models = {
    ActionProposal: { create: creator('ActionProposal') },
    ActionOutcome: {
      create: creator('ActionOutcome'),
      findOne: (filter) => {
        log.push({ op: 'ActionOutcome.findOne', filter });
        const chain = {
          session: () => chain,
          lean: async () => existingOutcome,
        };
        return chain;
      },
    },
  };

  const tickets = {
    calls: [],
    async applyEscalation(ctx, value, session) {
      tickets.calls.push({ ctx, escalation: value, session });
      const error = take(ticketErrors);
      if (error) throw error;
      return { ticketId: 'ticket-1', status: 'open', created: true };
    },
  };

  const repo = makeMongoActionRepo({
    models,
    tickets,
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
  });

  const ops = (name) => log.filter((entry) => entry.op === name);
  return { repo, ops, sessions, tickets };
}

test('without an escalation, recording is unchanged: no session and no ticket', async () => {
  const { repo, ops, sessions, tickets } = setup();
  const result = await repo.recordOutcome(CTX, { ...outcomeDoc, outcome: 'refused_at_proposal' });
  assert.equal(result.duplicate, false);
  assert.equal(sessions.length, 0);
  assert.equal(tickets.calls.length, 0);
  assert.equal(ops('ActionOutcome.create')[0].options, undefined);
});

test('ADR 0010: an outcome that escalates shares ONE session with its ticket write', async () => {
  const { repo, ops, sessions, tickets } = setup();
  const result = await repo.recordOutcome(CTX, outcomeDoc, { escalation });

  assert.equal(result.duplicate, false);
  assert.equal(result.outcome.outcome, 'escalated_at_proposal');
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(ops('ActionOutcome.create')[0].options.session, session);
  assert.equal(tickets.calls.length, 1);
  assert.equal(tickets.calls[0].session, session);
  assert.deepEqual(tickets.calls[0].escalation, { ...escalation, proposalId: 'prop-1' });
  assert.equal(ops('ActionOutcome.create')[0].docs[0].tenantId, 't1');
  assert.equal(session.ended, true);
});

test('ADR 0010: a malformed proposal that escalates shares a session with its ticket, which names the new proposal', async () => {
  const { repo, ops, sessions, tickets } = setup();
  const proposal = await repo.recordProposal(
    CTX,
    { customerId: 'cust-1', conversationId: 'conv-1', validity: 'malformed', problemCodes: ['missing_target'] },
    { escalation: { ...escalation, reason: 'proposal_malformed' } },
  );

  const [session] = sessions;
  assert.equal(ops('ActionProposal.create')[0].options.session, session);
  assert.equal(tickets.calls[0].session, session);
  assert.equal(tickets.calls[0].escalation.proposalId, proposal._id);
});

test('a duplicate outcome key: the winner’s row is the answer, and nothing more is escalated', async () => {
  const winner = { _id: 'out-9', proposalId: 'prop-1', outcome: 'escalated_at_proposal' };
  const { repo, tickets, sessions } = setup({ createErrors: [duplicateKey()], existingOutcome: winner });

  const result = await repo.recordOutcome(CTX, outcomeDoc, { escalation });

  assert.deepEqual(result, { outcome: winner, duplicate: true });
  assert.equal(tickets.calls.length, 0, 'the winner escalated with its own outcome');
  assert.equal(sessions.length, 1);
});

test('losing the race for the conversation’s ticket: the whole write is retried once, and succeeds', async () => {
  const { repo, ops, sessions, tickets } = setup({ ticketErrors: [duplicateKey()], existingOutcome: null });

  const result = await repo.recordOutcome(CTX, outcomeDoc, { escalation });

  assert.equal(result.duplicate, false);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((session) => session.ended));
  assert.equal(ops('ActionOutcome.create').length, 2, 'the first attempt was rolled back and written again');
  assert.equal(tickets.calls.length, 2);
});

test('any other ticket failure is not retried, and propagates — the outcome was never committed without it', async () => {
  const { repo, sessions, tickets } = setup({ ticketErrors: [new Error('not primary')] });
  await assert.rejects(repo.recordOutcome(CTX, outcomeDoc, { escalation }), /not primary/);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].ended, true);
  assert.equal(tickets.calls.length, 1);
});

test('a malformed proposal that loses the ticket race is retried once too', async () => {
  const { repo, sessions } = setup({ ticketErrors: [duplicateKey()] });
  await repo.recordProposal(CTX, { validity: 'malformed' }, { escalation: { ...escalation, reason: 'proposal_malformed' } });
  assert.equal(sessions.length, 2);
});
