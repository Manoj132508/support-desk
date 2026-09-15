import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makeTicketsRouter } from '../src/routes/tickets.js';
import { makeConversationEscalationRouter } from '../src/routes/conversationEscalation.js';
import { errorEnvelope } from '../src/middleware/errorEnvelope.js';

/**
 * The ticket routes and the customer's escalation route, with fake services.
 * The services' behaviour is tested elsewhere; asserted here is who may call
 * each route and where every identifier comes from.
 */

const user = (role, extra = {}) => ({ id: `${role}-1`, role, tenantId: 't1', customerId: null, ...extra });
const CUSTOMER = user('customer', { customerId: 'cust-1' });

function fakeService() {
  const calls = [];
  const record = (name, answer) => async (...args) => {
    calls.push({ name, args });
    return answer;
  };
  return {
    calls,
    list: record('list', { tickets: [], counts: {}, page: { limit: 25, nextCursor: null } }),
    detail: record('detail', { ticket: { id: 'ticket-1' } }),
    transition: record('transition', { ticket: { id: 'ticket-1', status: 'assigned' } }),
    escalateForCustomer: record('escalateForCustomer', { escalation: { ticketId: 'ticket-1', status: 'open', created: true } }),
  };
}

async function request(method, path, { as, service, body }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.correlationId = 'corr-test';
    if (as) {
      req.user = as;
      req.tenantId = as.tenantId;
    }
    next();
  });
  app.use('/api/tickets', makeTicketsRouter({ service }));
  app.use('/api/conversations', makeConversationEscalationRouter({ service }));
  app.use(errorEnvelope);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    // fetch refuses a body on GET, so a shared call list can pass one to every
    // method and only the methods that carry one send it.
    const sendsBody = body !== undefined && method !== 'GET';
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: sendsBody ? { 'Content-Type': 'application/json' } : {},
      body: sendsBody ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('every staff role can reach the queue, a ticket, and its status', async () => {
  for (const role of ['agent', 'lead', 'admin']) {
    const service = fakeService();
    assert.equal((await request('GET', '/api/tickets', { as: user(role), service })).status, 200, role);
    assert.equal((await request('GET', '/api/tickets/ticket-1', { as: user(role), service })).status, 200, role);
    assert.equal(
      (await request('POST', '/api/tickets/ticket-1/status', { as: user(role), service, body: { status: 'assigned' } })).status,
      200,
      role,
    );
  }
});

test('ADR 0007: a customer cannot read tickets — they carry the internal channel', async () => {
  const service = fakeService();
  for (const [method, path] of [['GET', '/api/tickets'], ['GET', '/api/tickets/ticket-1'], ['POST', '/api/tickets/ticket-1/status']]) {
    assert.equal((await request(method, path, { as: CUSTOMER, service, body: {} })).status, 403, path);
  }
  assert.equal(service.calls.length, 0);
});

test('no session is 401', async () => {
  assert.equal((await request('GET', '/api/tickets', { service: fakeService() })).status, 401);
});

test('the query string reaches the service as given, with the tenant from the session', async () => {
  const service = fakeService();
  await request('GET', '/api/tickets?status=waiting&limit=5', { as: user('agent'), service });
  const [{ args }] = service.calls;
  assert.equal(args[0].tenantId, 't1');
  assert.deepEqual({ ...args[1] }, { status: 'waiting', limit: '5' });
});

test('FR-9: a transition is made by the signed-in user, whoever the body claims to be', async () => {
  const service = fakeService();
  await request('POST', '/api/tickets/ticket-1/status', {
    as: user('agent'),
    service,
    body: { status: 'resolved', userId: 'someone-else', actor: { kind: 'system' } },
  });
  const [{ args }] = service.calls;
  assert.equal(args[1].ticketId, 'ticket-1');
  assert.equal(args[1].to, 'resolved');
  assert.equal(args[1].user.id, 'agent-1');
  assert.equal(args[1].correlationId, 'corr-test');
  assert.equal('actor' in args[1], false);
});

test('FR-8.2: a customer asks for a person on their conversation, with identity from the session', async () => {
  const service = fakeService();
  const { status, body } = await request('POST', '/api/conversations/conv-1/escalate', {
    as: CUSTOMER,
    service,
    body: { proposalId: 'p1', customerId: 'someone-else', reason: 'policy_agent_only' },
  });

  assert.equal(status, 200);
  assert.deepEqual(body, { escalation: { ticketId: 'ticket-1', status: 'open', created: true } });
  const [{ name, args }] = service.calls;
  assert.equal(name, 'escalateForCustomer');
  assert.deepEqual(args[1], {
    customerId: 'cust-1',
    conversationId: 'conv-1',
    proposalId: 'p1',
    userId: 'customer-1',
    correlationId: 'corr-test',
  });
});

test('a proposal id that is not a string is dropped rather than passed on', async () => {
  const service = fakeService();
  await request('POST', '/api/conversations/conv-1/escalate', { as: CUSTOMER, service, body: { proposalId: { $ne: null } } });
  assert.equal(service.calls[0].args[1].proposalId, null);
});

test('staff cannot use the customer’s escalation route, and a customer with no profile finds nothing', async () => {
  const service = fakeService();
  assert.equal((await request('POST', '/api/conversations/conv-1/escalate', { as: user('agent'), service })).status, 403);
  assert.equal(
    (await request('POST', '/api/conversations/conv-1/escalate', { as: user('customer'), service })).status,
    404,
  );
  assert.equal(service.calls.length, 0);
});
