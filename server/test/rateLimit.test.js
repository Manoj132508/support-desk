import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makeLimiter, perUser, messageLimiter } from '../src/middleware/rateLimit.js';
import { errorEnvelope } from '../src/middleware/errorEnvelope.js';
import { conversationsRouter } from '../src/routes/conversations.js';
import { makeConversationEscalationRouter } from '../src/routes/conversationEscalation.js';

/**
 * NFR-3 and OWASP API4. Each test builds its own limiter, because the exported
 * ones keep their counts in module state for the life of the process.
 */

async function withApp(mount, run) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.correlationId = 'corr-test';
    const id = req.get('x-test-user');
    const role = req.get('x-test-role') ?? 'customer';
    if (id) req.user = { id, role, tenantId: 't1', customerId: role === 'customer' ? `cust-${id}` : null };
    next();
  });
  mount(app);
  app.use(errorEnvelope);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const call = async (path, { user, role, method = 'GET' } = {}) => {
    const headers = {};
    if (user) headers['x-test-user'] = user;
    if (role) headers['x-test-role'] = role;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers });
    return { status: response.status, body: await response.json() };
  };
  try {
    return await run(call);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('NFR-3: past the limit, a 429 in the envelope — expected, so no stack trace, and one security-event line', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const warnings = t.mock.method(console, 'warn', () => {});
  const limiter = makeLimiter({ name: 'test', windowMs: 60_000, limit: 2, keyGenerator: perUser });

  await withApp(
    (app) => app.get('/limited', limiter, (req, res) => res.json({ ok: true })),
    async (call) => {
      const statuses = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await call('/limited', { user: 'u1' })).status);
      assert.deepEqual(statuses, [200, 200, 429]);

      const { body } = await call('/limited', { user: 'u1' });
      assert.equal(body.kind, 'fault');
      assert.equal(body.message, 'Too many requests');
    },
  );

  assert.equal(errors.mock.callCount(), 0, 'a rate limit is not a bug and must not log a stack trace');
  const events = warnings.mock.calls.map((call) => JSON.parse(call.arguments[0]));
  assert.ok(events.length >= 1);
  assert.deepEqual(
    { event: events[0].event, limiter: events[0].limiter, userId: events[0].userId },
    { event: 'rate_limited', limiter: 'test', userId: 'u1' },
  );
  assert.equal('ip' in events[0], false, 'the security event does not record the client’s address');
});

test('signed-in routes are limited per user: one customer’s burst does not throttle another at the same address', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const limiter = makeLimiter({ name: 'test', windowMs: 60_000, limit: 1, keyGenerator: perUser });

  await withApp(
    (app) => app.get('/limited', limiter, (req, res) => res.json({ ok: true })),
    async (call) => {
      assert.equal((await call('/limited', { user: 'u1' })).status, 200);
      assert.equal((await call('/limited', { user: 'u1' })).status, 429);
      assert.equal((await call('/limited', { user: 'u2' })).status, 200);
    },
  );
});

test('the key is the user when signed in, and the address otherwise', () => {
  assert.equal(perUser({ user: { id: 'u1' }, ip: '10.0.0.1' }), 'user:u1');
  assert.equal(perUser({ ip: '10.0.0.1' }), 'ip:10.0.0.1');
});

test('OWASP API4: the message route — a call to the AI service each time — is rate limited', () => {
  const layer = conversationsRouter.stack.find((entry) => entry.route?.path === '/:id/messages');
  assert.ok(layer, 'no /:id/messages route');
  const handlers = layer.route.stack.map((entry) => entry.handle);
  assert.ok(handlers.includes(messageLimiter), 'the message limiter is not mounted on the route');
});

test('Phase 11 §11: escalation is rate limited, after the role check, so a refused staff call counts against nobody', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const limiter = makeLimiter({ name: 'escalation-test', windowMs: 60_000, limit: 1, keyGenerator: perUser });
  const service = { escalateForCustomer: async () => ({ escalation: { ticketId: 't', status: 'open', created: true } }) };

  await withApp(
    (app) => app.use('/api/conversations', makeConversationEscalationRouter({ service, limiter })),
    async (call) => {
      const path = '/api/conversations/conv-1/escalate';
      assert.equal((await call(path, { method: 'POST', user: 'a1', role: 'agent' })).status, 403);
      assert.equal((await call(path, { method: 'POST', user: 'a1', role: 'agent' })).status, 403);
      assert.equal((await call(path, { method: 'POST', user: 'c1' })).status, 200);
      assert.equal((await call(path, { method: 'POST', user: 'c1' })).status, 429);
    },
  );
});
