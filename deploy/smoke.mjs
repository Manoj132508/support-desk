import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';

/**
 *   node deploy/smoke.mjs http://localhost:5179
 *
 * The running compose stack, checked from outside, as a browser meets it.
 * Phase 15; CI runs it after `docker compose up` (.github/workflows/deploy.yml).
 *
 * Everything here was decided elsewhere and can only be seen with the stack
 * running: the headers nginx really sends, and whether they land where nginx's
 * inheritance rules say they should; that only nginx is reachable; and that a
 * request passes through nginx and the API to the database.
 */

const base = (process.argv[2] ?? 'http://localhost:5179').replace(/\/$/, '');
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

const expectedCsp = readFileSync(new URL('../client/deploy/security-headers.conf', import.meta.url), 'utf8')
  .replace(/#.*$/gm, '')
  .match(/add_header Content-Security-Policy "([^"]+)" always;/)[1];

// Five minutes by default: the AI image loads its embedding model before it
// answers. Shorter only for trying the script against something that will never
// be fully healthy.
async function waitForHealth(timeoutMs = Number(process.env.SMOKE_HEALTH_TIMEOUT_MS ?? 300_000)) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await (await fetch(`${base}/api/health`)).json();
      if (last.database === 'ok' && last.aiService === 'ok') return last;
    } catch {
      // nginx or the API is not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return last;
}

/**
 * Whether nothing accepts a TCP connection on this port. A connection, not an
 * HTTP request: MongoDB accepts the connection and then does not speak HTTP, so
 * a failed `fetch` could not tell "not reachable" from "reachable, not a web
 * server" -- which is how an early version passed this check with a mongod
 * listening on the port.
 */
const refuses = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(3_000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(true));
  });

const health = await waitForHealth();
check(health?.database === 'ok', `database reachable through nginx and the API (health: ${JSON.stringify(health)})`);
check(health?.aiService === 'ok', 'the AI service answers the API');

const page = await fetch(`${base}/`);
const html = await page.text();
check(page.status === 200 && html.includes('<div id="root">'), 'the app is served');
check(page.headers.get('content-security-policy') === expectedCsp, 'index.html carries the CSP, exactly as written in security-headers.conf');
check(page.headers.get('x-frame-options') === 'DENY', 'index.html cannot be framed');
check(page.headers.get('cache-control') === 'no-cache', 'index.html is not cached');

const deepLink = await fetch(`${base}/console/tickets`);
check(deepLink.status === 200 && (await deepLink.text()).includes('<div id="root">'), 'a client route is served the app, not a 404');
check(deepLink.headers.get('content-security-policy') === expectedCsp, 'a client route carries the CSP');

const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
const asset = script ? await fetch(`${base}${script}`) : null;
check(asset?.status === 200, `the hashed bundle is served (${script})`);
check(/immutable/.test(asset?.headers.get('cache-control') ?? ''), 'hashed assets are cached as immutable');
check(asset?.headers.get('content-security-policy') === expectedCsp, 'assets keep the security headers beside their own Cache-Control');

const apiHealth = await fetch(`${base}/api/health`);
// A header sent twice arrives joined: "nosniff, nosniff". It would mean nginx's
// headers leaked onto the API's own.
check(apiHealth.headers.get('x-content-type-options') === 'nosniff', 'API responses carry helmet\'s headers once, not nginx\'s as well');

const signIn = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tenantSlug: 'acme', email: 'nobody@example.test', password: 'not-a-real-password' }),
});
check(signIn.status === 401, `a sign-in reaches the database through nginx and is refused (${signIn.status})`);

// By IPv4 address, not `localhost`, which Node resolves to ::1 first: a service
// listening on IPv4 only would refuse for the wrong reason.
check(await refuses(4400), 'the API is not reachable except through nginx');
check(await refuses(8200), 'the AI service is not reachable from outside');
check(await refuses(27017), 'MongoDB is not reachable from outside');

if (failures.length > 0) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log('\nsmoke: the stack is up and behaves as designed');
