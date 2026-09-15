import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCredentials, readCredentials } from '../src/auth/login.js';

/**
 * Signing in (Phase 12): within a tenant, and the same answer for every kind of
 * failure.
 */

const ACME = { _id: 'tenant-acme', slug: 'acme' };
const ANA = { _id: 'user-ana', tenantId: 'tenant-acme', email: 'ana@acme.test', passwordHash: 'hash', status: 'active' };

function lookups({ tenant = ACME, user = ANA, passwordMatches = true } = {}) {
  const calls = { tenants: [], users: [], verified: [] };
  return {
    calls,
    findTenantBySlug: async (slug) => {
      calls.tenants.push(slug);
      return tenant;
    },
    findUserForLogin: async (tenantId, email) => {
      calls.users.push({ tenantId, email });
      return user;
    },
    verifyPassword: async (password, hash) => {
      calls.verified.push({ password, hash });
      return passwordMatches && hash !== undefined;
    },
  };
}

const credentials = { email: ' Ana@Acme.test ', password: 'correct horse battery', tenantSlug: ' ACME ' };

test('INV-D, Phase 12: the user is looked up WITHIN the tenant, never by email alone', async () => {
  const deps = lookups();
  const user = await checkCredentials(credentials, deps);

  assert.equal(user, ANA);
  assert.deepEqual(deps.calls.tenants, ['acme']);
  assert.deepEqual(deps.calls.users, [{ tenantId: 'tenant-acme', email: 'ana@acme.test' }]);
});

test('an unknown organisation is refused like a wrong password, after the same full comparison', async () => {
  const deps = lookups({ tenant: null });
  assert.equal(await checkCredentials(credentials, deps), null);
  assert.equal(deps.calls.users.length, 0);
  assert.deepEqual(deps.calls.verified, [{ password: 'correct horse battery', hash: undefined }]);
});

test('an unknown email and a wrong password are refused the same way', async () => {
  assert.equal(await checkCredentials(credentials, lookups({ user: null })), null);
  assert.equal(await checkCredentials(credentials, lookups({ passwordMatches: false })), null);
});

test('a disabled account is refused even with the right password', async () => {
  assert.equal(await checkCredentials(credentials, lookups({ user: { ...ANA, status: 'disabled' } })), null);
});

test('A03: a query operator in place of a string is read as empty, and never reaches a lookup', async () => {
  const deps = lookups();
  const injected = { email: { $ne: null }, password: 'x', tenantSlug: { $gt: '' } };

  assert.equal(await checkCredentials(injected, deps), null);
  assert.equal(deps.calls.tenants.length, 0);
  assert.equal(deps.calls.users.length, 0);
  assert.equal(deps.calls.verified.length, 1, 'the comparison still runs, so timing reveals nothing');
});

test('a missing organisation asks nothing of the database', async () => {
  const deps = lookups();
  assert.equal(await checkCredentials({ email: 'ana@acme.test', password: 'x' }, deps), null);
  assert.equal(deps.calls.tenants.length, 0);
});

test('credentials are normalised: trimmed, and email and organisation lower-cased', () => {
  assert.deepEqual(readCredentials(credentials), {
    email: 'ana@acme.test',
    password: 'correct horse battery',
    tenantSlug: 'acme',
  });
  assert.deepEqual(readCredentials(undefined), { email: '', password: '', tenantSlug: '' });
});
