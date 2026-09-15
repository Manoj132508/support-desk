import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makeAccountRouter } from '../src/routes/account.js';
import { makeLimiter, perUser } from '../src/middleware/rateLimit.js';
import { errorEnvelope } from '../src/middleware/errorEnvelope.js';
import { AppError } from '../src/errors/AppError.js';

/**
 * POST /api/account/delete, with a fake deletion service: who may call it,
 * where the identity comes from, and that the session ends with the account.
 */

const CUSTOMER = { id: 'user-1', role: 'customer', tenantId: 't1', customerId: 'cust-1' };
const AGENT = { id: 'agent-1', role: 'agent', tenantId: 't1', customerId: null };

function fakeDeletion(behaviour) {
  const calls = [];
  return {
    calls,
    async deleteOwnAccount(args) {
      calls.push(args);
      if (behaviour) return behaviour(args);
      return { messages: 1, conversations: 1, ticketsScrubbed: 0 };
    },
  };
}

async function post({ as, deletion, body, limiter }) {
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
  const permissive = makeLimiter({ name: 'test', windowMs: 60_000, limit: 100, keyGenerator: perUser });
  app.use('/api/account', makeAccountRouter({ deletion, limiter: limiter ?? permissive }));
  app.use(errorEnvelope);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/account/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, cookies: response.headers.getSetCookie() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('FR-13.4: a customer deletes their own account with their password, and the session cookies are cleared', async () => {
  const deletion = fakeDeletion();
  const { status, cookies } = await post({
    as: CUSTOMER,
    deletion,
    body: { password: 'correct horse battery', userId: 'someone-else', customerId: 'cust-9' },
  });

  assert.equal(status, 204);
  assert.equal(deletion.calls.length, 1);
  assert.equal(deletion.calls[0].user, deletion.calls[0].ctx.user, 'the identity is the session’s');
  assert.equal(deletion.calls[0].user.customerId, 'cust-1');
  assert.equal(deletion.calls[0].password, 'correct horse battery');
  assert.ok(cookies.some((cookie) => cookie.startsWith('asd_session=;')), 'session cookie cleared');
  assert.ok(cookies.some((cookie) => cookie.startsWith('asd_csrf=;')), 'CSRF cookie cleared');
});

test('staff cannot use it, and no session is 401', async () => {
  const deletion = fakeDeletion();
  assert.equal((await post({ as: AGENT, deletion, body: { password: 'x' } })).status, 403);
  assert.equal((await post({ deletion, body: { password: 'x' } })).status, 401);
  assert.equal(deletion.calls.length, 0);
});

test('a wrong password is refused, and the session is left as it was', async () => {
  const deletion = fakeDeletion(() => {
    throw new AppError('fault', { message: 'Password confirmation failed', status: 403, expected: true });
  });
  const { status, cookies } = await post({ as: CUSTOMER, deletion, body: { password: 'guess' } });
  assert.equal(status, 403);
  assert.equal(cookies.length, 0);
});

test('it is rate limited per user, because it compares a password', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const limiter = makeLimiter({ name: 'account-test', windowMs: 60_000, limit: 1, keyGenerator: perUser });
  const deletion = fakeDeletion(() => {
    throw new AppError('fault', { message: 'Password confirmation failed', status: 403, expected: true });
  });
  // One app per call, but the limiter is shared, as the real one is.
  assert.equal((await post({ as: CUSTOMER, deletion, body: { password: 'guess' }, limiter })).status, 403);
  assert.equal((await post({ as: CUSTOMER, deletion, body: { password: 'guess' }, limiter })).status, 429);
});
