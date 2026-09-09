import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, MINIMUM_ROUNDS } from '../src/auth/password.js';
import { buildRegistration, publicUser, SELF_REGISTRATION_ROLE, MIN_PASSWORD_LENGTH } from '../src/auth/registration.js';
import { baseCookieOptions, SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER } from '../src/auth/cookies.js';
import { requireCsrfToken } from '../src/middleware/csrf.js';
import { requireRole, STAFF, LEADERSHIP } from '../src/middleware/requireRole.js';
import { makeAuthenticate } from '../src/middleware/authenticate.js';
import { config } from '../src/config/env.js';
import { User } from '../src/db/models/index.js';

/* ── Passwords ──────────────────────────────────────────────────────────── */

test('a password round-trips through hash and verify', async () => {
  // Cost 4 keeps the test fast. The POLICY (cost 12) is asserted separately
  // below, so both the mechanism and the setting are covered without paying
  // for a 12-round hash in every run.
  const hash = await hashPassword('correct horse battery staple', 4);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password entirely', hash), false);
});

test('the same password hashes differently every time', async () => {
  // Per-password salt, embedded in the output. Two users sharing a password
  // must not share a hash, or a rainbow table works.
  const a = await hashPassword('same password here', 4);
  const b = await hashPassword('same password here', 4);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same password here', b), true);
});

test('the configured cost meets the recommended floor', () => {
  assert.ok(
    config.bcryptRounds >= MINIMUM_ROUNDS,
    `bcrypt cost ${config.bcryptRounds} is below the recommended ${MINIMUM_ROUNDS}`,
  );
});

test('verifying against a missing hash still costs a full comparison', async () => {
  // The account-enumeration defence. A short-circuit would return in
  // microseconds while a real comparison takes hundreds of milliseconds, and
  // that difference is measurable over the network.
  const start = process.hrtime.bigint();
  const result = await verifyPassword('anything at all', null);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  assert.equal(result, false);
  assert.ok(elapsedMs > 5, `expected real work, took ${elapsedMs.toFixed(1)}ms`);
});

/* ── Registration ───────────────────────────────────────────────────────── */

const validBody = {
  email: '  Person@Example.COM ',
  password: 'a sufficiently long passphrase',
  name: 'Person',
  tenantSlug: 'Acme',
};

test('registration normalises email and tenant slug', () => {
  const result = buildRegistration(validBody);
  assert.equal(result.email, 'person@example.com');
  assert.equal(result.tenantSlug, 'acme');
});

test('SELF-REGISTRATION CANNOT CREATE STAFF, whatever the body says', () => {
  // The single worst bug available in this system. An attacker who could
  // self-assign `admin` would become the person who edits the policy rules
  // deciding what the assistant may do -- so the role is a constant, not a
  // defaulted input.
  for (const attempt of ['admin', 'lead', 'agent', 'ADMIN', ['admin'], { role: 'admin' }]) {
    const result = buildRegistration({ ...validBody, role: attempt });
    assert.equal(result.role, SELF_REGISTRATION_ROLE);
    assert.equal(result.role, 'customer');
  }
});

test('registration rejects a short password, a bad email, and missing fields', () => {
  assert.throws(() => buildRegistration({ ...validBody, password: 'short' }), /at least/);
  assert.throws(() => buildRegistration({ ...validBody, email: 'not-an-email' }), /valid email/);
  assert.throws(() => buildRegistration({ ...validBody, name: '  ' }), /name is required/);
  assert.throws(() => buildRegistration({ ...validBody, tenantSlug: '' }), /tenantSlug/);
  assert.throws(() => buildRegistration({}), /Registration rejected/);
});

test('the minimum password length favours length over composition rules', () => {
  assert.ok(MIN_PASSWORD_LENGTH >= 12);
});

test('a registration failure is malformed (422), so it is not a policy refusal', () => {
  try {
    buildRegistration({});
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.kind, 'malformed');
    assert.equal(error.status, 422);
  }
});

test('publicUser never carries the password hash', () => {
  const shaped = publicUser({
    _id: 'u1',
    email: 'a@b.com',
    name: 'A',
    role: 'customer',
    tenantId: 't1',
    passwordHash: '$2a$12$secret',
  });
  assert.equal(shaped.passwordHash, undefined);
  assert.deepEqual(Object.keys(shaped).sort(), ['email', 'id', 'name', 'role', 'tenantId']);
});

test('the schema excludes passwordHash by default, as a second independent guard', () => {
  assert.equal(User.schema.path('passwordHash').options.select, false);
});

/* ── Cookies ────────────────────────────────────────────────────────────── */

test('the session cookie is httpOnly, SameSite=Strict, and path-scoped', () => {
  const options = baseCookieOptions();
  assert.equal(options.httpOnly, true, 'XSS must not be able to read the session');
  assert.equal(options.sameSite, 'strict', 'the first CSRF defence');
  assert.equal(options.path, '/');
});

test('secure follows the environment rather than being hard-coded', () => {
  // Hard-coding `true` drops the cookie over plain http in development;
  // hard-coding `false` ships an insecure cookie to production.
  assert.equal(baseCookieOptions().secure, config.isProduction);
});

test('the two cookies have distinct names and the header matches', () => {
  assert.notEqual(SESSION_COOKIE, CSRF_COOKIE);
  assert.equal(CSRF_HEADER, 'x-csrf-token');
});

/* ── CSRF ───────────────────────────────────────────────────────────────── */

function runCsrf({ method = 'POST', cookie, header }) {
  let passed = false;
  let error = null;
  const req = {
    method,
    cookies: cookie ? { [CSRF_COOKIE]: cookie } : {},
    get: (name) => (name.toLowerCase() === CSRF_HEADER && header ? header : undefined),
  };
  requireCsrfToken(req, {}, (err) => {
    if (err) error = err;
    else passed = true;
  });
  return { passed, error };
}

test('a matching cookie and header passes', () => {
  assert.equal(runCsrf({ cookie: 'token-abc', header: 'token-abc' }).passed, true);
});

test('a missing header, missing cookie, or mismatch is rejected', () => {
  assert.equal(runCsrf({ cookie: 'token-abc' }).passed, false);
  assert.equal(runCsrf({ header: 'token-abc' }).passed, false);
  assert.equal(runCsrf({ cookie: 'token-abc', header: 'token-xyz' }).passed, false);
  assert.equal(runCsrf({}).passed, false);
});

test('tokens of different lengths are rejected without throwing', () => {
  // timingSafeEqual throws on length mismatch, so the length check must come
  // first. Getting this wrong turns a forged request into a 500.
  const { passed, error } = runCsrf({ cookie: 'short', header: 'a-much-longer-token-value' });
  assert.equal(passed, false);
  assert.equal(error.status, 403);
});

test('safe methods need no token, because a GET that mutates is the real bug', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    assert.equal(runCsrf({ method }).passed, true);
  }
});

test('a CSRF failure is a fault, not a policy refusal', () => {
  // `refused` is reserved for a policy rule declining an action; it renders in
  // the policy language and belongs in the audit that demonstrates INV-A. A
  // forged request is not a decision about anything.
  assert.equal(runCsrf({}).error.kind, 'fault');
});

/* ── Roles ──────────────────────────────────────────────────────────────── */

function runRole(guard, user) {
  let error = null;
  guard({ user }, {}, (err) => {
    error = err ?? null;
  });
  return error;
}

test('a role gate admits exactly the listed roles', () => {
  const guard = requireRole(LEADERSHIP);
  assert.equal(runRole(guard, { role: 'lead' }), null);
  assert.equal(runRole(guard, { role: 'admin' }), null);
  assert.equal(runRole(guard, { role: 'agent' }).status, 403);
  assert.equal(runRole(guard, { role: 'customer' }).status, 403);
});

test('a customer cannot reach staff routes', () => {
  assert.equal(runRole(requireRole(STAFF), { role: 'customer' }).status, 403);
});

test('no user at all is 401, not 403', () => {
  // Different problems with different fixes: sign in, versus you are signed in
  // and this is not for you.
  assert.equal(runRole(requireRole(STAFF), undefined).status, 401);
});

test('a role rejection is a fault, keeping access control out of the policy audit', () => {
  assert.equal(runRole(requireRole(STAFF), { role: 'customer' }).kind, 'fault');
});

/* ── authenticate ───────────────────────────────────────────────────────── */

async function runAuthenticate({ token, user }) {
  const authenticate = makeAuthenticate({ loadUser: async () => user });
  const req = { cookies: token ? { [SESSION_COOKIE]: token } : {} };
  let error = null;
  await authenticate(req, {}, (err) => {
    error = err ?? null;
  });
  return { req, error };
}

test('no session cookie is 401', async () => {
  const { error } = await runAuthenticate({});
  assert.equal(error.status, 401);
});

test('a forged token is 401, and says nothing about why', async () => {
  const { error } = await runAuthenticate({ token: 'not.a.real.token', user: null });
  assert.equal(error.status, 401);
  // "Expired" versus "invalid signature" tells an attacker which half of their
  // forgery was wrong.
  assert.equal(error.message, 'Authentication required');
});

test('a valid token for a deleted user is still 401', async () => {
  // The database lookup is not redundant: a signature proves the token was
  // minted by us, not that the account still exists.
  process.env.JWT_SECRET = 'test-secret-for-signing-only';
  const { signSessionToken } = await import('../src/auth/jwt.js');
  const { config: liveConfig } = await import('../src/config/env.js');
  liveConfig.jwtSecret = 'test-secret-for-signing-only';

  const token = signSessionToken('u1');
  const { error } = await runAuthenticate({ token, user: null });
  assert.equal(error.status, 401);
});

test('a disabled account is 401 even with a valid token', async () => {
  const { signSessionToken } = await import('../src/auth/jwt.js');
  const token = signSessionToken('u1');
  const { error } = await runAuthenticate({
    token,
    user: { _id: 'u1', email: 'a@b.com', role: 'admin', tenantId: 't1', status: 'disabled' },
  });
  assert.equal(error.status, 401);
});

test('a valid session sets req.user and req.tenantId from the DATABASE', async () => {
  const { signSessionToken } = await import('../src/auth/jwt.js');
  const token = signSessionToken('u1');
  const { req, error } = await runAuthenticate({
    token,
    user: {
      _id: 'u1',
      email: 'a@b.com',
      name: 'A',
      role: 'agent',
      tenantId: 't1',
      customerId: null,
      status: 'active',
    },
  });

  assert.equal(error, null);
  assert.equal(req.user.role, 'agent');
  // ADR 0005: the tenant a request operates in comes from the session, never
  // from a body, query string or header, so a caller cannot choose it.
  assert.equal(req.tenantId, 't1');
});

test('role and tenant are loaded fresh, so a demotion takes effect immediately', async () => {
  const { signSessionToken } = await import('../src/auth/jwt.js');
  // A token minted while this user was an admin...
  const token = signSessionToken('u1');

  // ...but the database now says agent. If role lived in the token, this user
  // would keep authorising things for another twelve hours.
  const { req } = await runAuthenticate({
    token,
    user: { _id: 'u1', email: 'a@b.com', role: 'agent', tenantId: 't1', status: 'active' },
  });
  assert.equal(req.user.role, 'agent');
});

test('req.user is a plain object, not a Mongoose document', async () => {
  const { signSessionToken } = await import('../src/auth/jwt.js');
  const token = signSessionToken('u1');
  const { req } = await runAuthenticate({
    token,
    user: {
      _id: 'u1',
      email: 'a@b.com',
      role: 'agent',
      tenantId: 't1',
      status: 'active',
      save: () => {
        throw new Error('a handler must not be able to call this');
      },
    },
  });
  assert.equal(req.user.save, undefined);
  assert.equal(req.user.passwordHash, undefined);
});
