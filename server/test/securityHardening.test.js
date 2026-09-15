import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { errorEnvelope } from '../src/middleware/errorEnvelope.js';
import { requireCsrfToken } from '../src/middleware/csrf.js';
import { AppError } from '../src/errors/AppError.js';
import { scoped } from '../src/db/tenantScope.js';
import { Conversation } from '../src/db/models/index.js';
import { config, productionConfigProblems } from '../src/config/env.js';
import { signSessionToken, verifySessionToken } from '../src/auth/jwt.js';

/**
 * Phase 12's smaller fixes, each with the failure it closes.
 */

const CTX = { tenantId: '64b7f0c2a1b2c3d4e5f60700' };
const VALID_ID = '64b7f0c2a1b2c3d4e5f60718';

function render(error, user = { role: 'customer' }) {
  let status = null;
  let payload = null;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };
  errorEnvelope(error, { correlationId: 'c1', user, method: 'POST', originalUrl: '/api/x' }, res, () => {});
  return { status, payload };
}

/* ── A05: what an error tells the caller ─────────────────────────────── */

test('A05: an unexpected error’s message goes to the log, never to the caller', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const driverError = Object.assign(
    new Error('E11000 duplicate key error collection: users index: tenantId_1_email_1 dup key: { email: "ana@acme.test" }'),
    { code: 11000 },
  );

  const { status, payload } = render(driverError);

  assert.equal(status, 500);
  assert.equal(payload.message, 'Something went wrong');
  assert.equal(JSON.stringify(payload).includes('ana@acme.test'), false);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments[0], /E11000/, 'the real message is kept for whoever reads the log');
});

test('an unexpected fault raised on purpose is treated the same: its message describes internals', (t) => {
  t.mock.method(console, 'error', () => {});
  assert.equal(render(AppError.fault('tenantScope called without a tenant context')).payload.message, 'Something went wrong');
});

test('expected errors keep their messages, which were written to be read', () => {
  assert.equal(render(AppError.malformed('Invalid ticket query: limit must be a whole number')).payload.message,
    'Invalid ticket query: limit must be a whole number');
  assert.equal(render(new AppError('fault', { message: 'Authentication required', status: 401, expected: true })).payload.message,
    'Authentication required');
});

test('a forged request is the defence working: a CSRF rejection is expected, and logged as one event line', (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  let passed = null;
  requireCsrfToken({ method: 'POST', cookies: {}, get: () => undefined, originalUrl: '/api/proposals/p/confirm' }, {}, (error) => {
    passed = error;
  });
  assert.equal(passed.status, 403);
  assert.equal(passed.expected, true);
  assert.equal(JSON.parse(warnings.mock.calls[0].arguments[0]).event, 'csrf_rejected');
});

/* ── Malformed ids ────────────────────────────────────────────────────── */

test('INV-D, A05: an id that cannot be an ObjectId is not found, without a query', async () => {
  const calls = [];
  const Model = {
    findOne: (filter) => {
      calls.push(filter);
      return Promise.resolve(null);
    },
  };
  await assert.rejects(scoped(Model, CTX).findByIdOrNotFound('abc'), (error) => error.status === 404);
  assert.equal(calls.length, 0);
});

test('findById with a malformed id asks for nothing rather than throwing a cast error', () => {
  const calls = [];
  const Model = { findOne: (filter) => calls.push(filter) };
  scoped(Model, CTX).findById('abc');
  assert.deepEqual(calls[0], { _id: { $in: [] }, tenantId: CTX.tenantId });
  scoped(Model, CTX).findById(VALID_ID);
  assert.deepEqual(calls[1], { _id: VALID_ID, tenantId: CTX.tenantId });
});

test('the real model: a malformed conversation id is a plain 404, not a CastError naming the model', async () => {
  await assert.rejects(scoped(Conversation, CTX).findByIdOrNotFound('abc'), (error) => {
    assert.equal(error.status, 404);
    assert.doesNotMatch(error.message, /Cast|Conversation/);
    return true;
  });
});

/* ── A02: session tokens ──────────────────────────────────────────────── */

test('A02: a session token is HS256, and verifies', () => {
  config.jwtSecret = 'z'.repeat(40);
  const token = signSessionToken('u1');
  assert.equal(jwt.decode(token, { complete: true }).header.alg, 'HS256');
  assert.equal(verifySessionToken(token).sub, 'u1');
});

test('A02: the same secret under another algorithm is refused — the token’s header does not choose', () => {
  config.jwtSecret = 'z'.repeat(40);
  const token = jwt.sign({ sub: 'u1' }, config.jwtSecret, { algorithm: 'HS512', issuer: 'asd' });
  assert.equal(verifySessionToken(token), null);
});

test('A02: an unsigned token is refused', () => {
  config.jwtSecret = 'z'.repeat(40);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: 'u1', iss: 'asd' })}.`;
  assert.equal(verifySessionToken(unsigned), null);
});

/* ── A05: production configuration ────────────────────────────────────── */

const complete = {
  jwtSecret: 'j'.repeat(32),
  aiServiceToken: 't'.repeat(32),
  mongodbUri: 'mongodb+srv://cluster.example.net/desk',
  aiServiceUrl: 'http://ai-service:8200',
};

test('a complete production configuration has no problems', () => {
  assert.deepEqual(productionConfigProblems(complete), []);
});

test('each missing or weak setting is named, and no value is echoed', () => {
  const problems = productionConfigProblems({ jwtSecret: 'hunter2hunter2', aiServiceToken: '', mongodbUri: '', aiServiceUrl: '' });
  assert.equal(problems.length, 4);
  assert.match(problems.join(' '), /JWT_SECRET/);
  assert.match(problems.join(' '), /AI_SERVICE_TOKEN/);
  assert.equal(problems.join(' ').includes('hunter2'), false);
});
