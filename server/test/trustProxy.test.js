import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.js';
import { config, parseTrustProxyHops } from '../src/config/env.js';

/**
 * Phase 15: which address the sign-in limiter counts, and why the API must only
 * be reachable through its proxy.
 *
 * The limiter counts sign-in attempts per client address (Phase 12). Behind a
 * proxy the socket address is the proxy's, so Express reads the client's from
 * X-Forwarded-For -- trusting as many hops as there are proxies. Trust one hop
 * too many and a caller's own header is believed; one too few and every
 * customer shares the proxy's address and one bucket.
 *
 * Each test file runs in its own process, so the limiter's counts start empty.
 */

const SIGN_IN_LIMIT = 20;

/**
 * Attempts against the auth limiter, through registration. Sign-in shares the
 * same limiter but runs a full bcrypt comparison even for an empty body -- on
 * purpose, so a missing account costs the same time as a wrong password -- and
 * 21 of those took 8 seconds. An empty registration is refused in milliseconds
 * after the limiter has counted it.
 */
async function signInAttempts(base, forwardedFor) {
  const statuses = [];
  for (let i = 0; i <= SIGN_IN_LIMIT; i += 1) {
    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor(i) },
      body: '{}',
    });
    statuses.push(response.status);
  }
  return statuses;
}

test('TRUST_PROXY_HOPS: one hop by default, a whole number when set, and nothing else accepted', () => {
  assert.equal(parseTrustProxyHops(undefined), 1);
  assert.equal(parseTrustProxyHops(''), 1);
  assert.equal(parseTrustProxyHops('0'), 0);
  assert.equal(parseTrustProxyHops('2'), 2);
  for (const bad of ['true', '-1', '1.5', 'one', ' 1']) {
    assert.throws(() => parseTrustProxyHops(bad), /TRUST_PROXY_HOPS/, bad);
  }
});

test('WHY THE API PORT IS NOT PUBLISHED: reached directly while trusting a hop, a forged header walks around the limit', async (t) => {
  t.after(() => (config.trustProxyHops = 1));
  config.trustProxyHops = 1;
  await withServer(async (base) => {
    const statuses = await signInAttempts(base, (i) => `203.0.113.${i}`);
    assert.ok(!statuses.includes(429), 'every attempt claimed a new address, and every claim was believed');
  });
});

test('behind one proxy that appends the real address, forging the header changes nothing', async (t) => {
  t.after(() => (config.trustProxyHops = 1));
  config.trustProxyHops = 1;
  await withServer(async (base) => {
    // nginx's $proxy_add_x_forwarded_for keeps what the client sent and adds
    // the address it actually saw. With one trusted hop, only that is read.
    const statuses = await signInAttempts(base, (i) => `203.0.113.${i}, 198.51.100.7`);
    assert.equal(statuses.at(-1), 429);
  });
});

test('with no trusted hop the header is ignored entirely, and the socket address is counted', async (t) => {
  t.after(() => (config.trustProxyHops = 1));
  config.trustProxyHops = 0;
  await withServer(async (base) => {
    const statuses = await signInAttempts(base, (i) => `192.0.2.${i}`);
    assert.equal(statuses.at(-1), 429);
  });
});
