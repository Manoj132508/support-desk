import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makeAuditRouter } from '../src/routes/audit.js';
import { errorEnvelope } from '../src/middleware/errorEnvelope.js';
import { AppError } from '../src/errors/AppError.js';

/**
 * The audit route. It exposes rule keys and matched conditions -- the internal
 * channel -- so who may reach it is the thing to test, along with passing the
 * query string through for strict validation.
 */

const user = (role) => ({ id: `${role}-1`, role, tenantId: 't1', customerId: null });

function fakeAudit(list) {
  const calls = [];
  return {
    calls,
    async list(ctx, query) {
      calls.push({ ctx, query });
      return list ? list(ctx, query) : { entries: [], page: { limit: 50, nextCursor: null } };
    },
  };
}

async function get(path, { as, audit }) {
  const app = express();
  app.use((req, res, next) => {
    req.correlationId = 'corr-test';
    if (as) {
      req.user = as;
      req.tenantId = as.tenantId;
    }
    next();
  });
  app.use('/api/audit', makeAuditRouter({ audit }));
  app.use(errorEnvelope);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('leads and admins can read the audit', async () => {
  for (const role of ['lead', 'admin']) {
    const { status, body } = await get('/api/audit', { as: user(role), audit: fakeAudit() });
    assert.equal(status, 200, role);
    assert.deepEqual(body, { entries: [], page: { limit: 50, nextCursor: null } });
  }
});

test('agents and customers cannot — the audit carries internal rule detail', async () => {
  for (const role of ['agent', 'customer']) {
    const audit = fakeAudit();
    const { status } = await get('/api/audit', { as: user(role), audit });
    assert.equal(status, 403, role);
    assert.equal(audit.calls.length, 0);
  }
});

test('no session is 401', async () => {
  const { status } = await get('/api/audit', { audit: fakeAudit() });
  assert.equal(status, 401);
});

test('the query string reaches the audit query as given, and the tenant comes from the session', async () => {
  const audit = fakeAudit();
  await get('/api/audit?preset=stopped&limit=5&cursor=abc', { as: user('lead'), audit });

  const [{ ctx, query }] = audit.calls;
  assert.equal(ctx.tenantId, 't1');
  assert.deepEqual({ ...query }, { preset: 'stopped', limit: '5', cursor: 'abc' });
});

test('an invalid query is a 422 from the audit query, surfaced unchanged', async () => {
  const audit = fakeAudit(() => {
    throw AppError.malformed('Invalid audit query: unknown filter "kinds"');
  });
  const { status, body } = await get('/api/audit?kinds=refused', { as: user('lead'), audit });
  assert.equal(status, 422);
  assert.equal(body.kind, 'malformed');
});
