import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makePoliciesRouter } from '../src/routes/policies.js';
import { errorEnvelope } from '../src/middleware/errorEnvelope.js';
import { AppError } from '../src/errors/AppError.js';

/**
 * The policy routes, with a fake policy admin service.
 *
 * The service's rules are tested elsewhere. What matters here is the role split
 * -- leads may read what the assistant is allowed to do, only admins may change
 * it -- and that the tenant and author come from the session, not the request.
 */

const user = (role) => ({ id: `${role}-1`, role, tenantId: 't1', customerId: null });

function fakeAdmin(overrides = {}) {
  const calls = [];
  const method = (name, fallback) => async (...args) => {
    calls.push([name, ...args]);
    return overrides[name] ? overrides[name](...args) : fallback;
  };
  return {
    calls,
    listPolicies: method('listPolicies', { baseline: [], tenant: [], tenantHasOwnRules: false }),
    createPolicy: method('createPolicy', { id: 'r1', version: 1 }),
    updatePolicy: method('updatePolicy', { id: 'r1', version: 2 }),
  };
}

async function request(method, path, { as, admin, body }) {
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
  app.use('/api/policies', makePoliciesRouter({ admin }));
  app.use(errorEnvelope);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('leads and admins can read the rules; agents and customers cannot', async () => {
  for (const role of ['lead', 'admin']) {
    const { status, body } = await request('GET', '/api/policies', { as: user(role), admin: fakeAdmin() });
    assert.equal(status, 200, role);
    assert.deepEqual(Object.keys(body).sort(), ['baseline', 'tenant', 'tenantHasOwnRules']);
  }
  for (const role of ['agent', 'customer']) {
    const admin = fakeAdmin();
    const { status } = await request('GET', '/api/policies', { as: user(role), admin });
    assert.equal(status, 403, role);
    assert.equal(admin.calls.length, 0);
  }
});

test('no session is 401', async () => {
  const { status } = await request('GET', '/api/policies', { admin: fakeAdmin() });
  assert.equal(status, 401);
});

test('ONLY AN ADMIN can create or edit a rule — a lead can see it but not change it', async () => {
  for (const [method, path] of [['POST', '/api/policies'], ['PUT', '/api/policies/r1']]) {
    const admin = fakeAdmin();
    const { status } = await request(method, path, { as: user('lead'), admin, body: { outcome: 'refuse' } });
    assert.equal(status, 403, `${method} ${path}`);
    assert.equal(admin.calls.length, 0);
  }
});

test('an admin creates a rule, and the author comes from the session', async () => {
  const admin = fakeAdmin();
  const { status, body } = await request('POST', '/api/policies', {
    as: user('admin'),
    admin,
    body: { ruleKey: 'TENANT-X', createdBy: 'someone-else' },
  });

  assert.equal(status, 201);
  assert.deepEqual(body, { rule: { id: 'r1', version: 1 } });
  const [, ctx, { definition, userId }] = admin.calls[0];
  assert.equal(ctx.tenantId, 't1');
  assert.equal(userId, 'admin-1');
  // The body is passed on as the definition; the service refuses createdBy as
  // an unexpected field, and the route never lets it stand in for the author.
  assert.equal(definition.createdBy, 'someone-else');
});

test('an admin edits a rule: id from the URL, changes from the body, author and tenant from the session', async () => {
  const admin = fakeAdmin();
  const { status, body } = await request('PUT', '/api/policies/rule-42', {
    as: user('admin'),
    admin,
    body: { outcome: 'refuse', tenantId: 't-other' },
  });

  assert.equal(status, 200);
  assert.deepEqual(body, { rule: { id: 'r1', version: 2 } });
  const [, ctx, { ruleId, changes, userId }] = admin.calls[0];
  assert.equal(ruleId, 'rule-42');
  assert.deepEqual(changes, { outcome: 'refuse', tenantId: 't-other' });
  assert.equal(userId, 'admin-1');
  assert.equal(ctx.tenantId, 't1', 'a tenantId in the body cannot move the request to another tenant');
});

test('the service’s refusals keep their status: baseline 403, stale 409, malformed 422', async () => {
  const cases = [
    [new AppError('fault', { message: 'Baseline rules are managed by the platform', status: 403, expected: true }), 403],
    [AppError.stale('TENANT-X has a newer version'), 409],
    [AppError.malformed('Rule rejected: auto-execute is modelled but not enabled'), 422],
  ];
  for (const [error, status] of cases) {
    const admin = fakeAdmin({
      updatePolicy: () => {
        throw error;
      },
    });
    const response = await request('PUT', '/api/policies/r1', { as: user('admin'), admin, body: { priority: 1 } });
    assert.equal(response.status, status, error.message);
  }
});
