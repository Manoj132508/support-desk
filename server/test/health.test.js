import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { withServer, call } from './helpers.js';
import { probeAiService } from '../src/services/aiClient.js';

const answering = (body, { ok = true } = {}) => async () => ({ ok, json: async () => body });

test('the AI service is reported ok only when it actually answers ok', async () => {
  const base = { url: 'http://ai.test', token: '' };
  assert.equal(await probeAiService({ ...base, fetchImpl: answering({ status: 'ok' }) }), 'ok');
  assert.equal(await probeAiService({ ...base, fetchImpl: answering({ status: 'starting' }) }), 'starting');
  assert.equal(await probeAiService({ ...base, fetchImpl: answering({}, { ok: false }) }), 'unreachable');
  assert.equal(
    await probeAiService({ ...base, fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('not json'); } }) }),
    'unreachable',
  );
  assert.equal(await probeAiService({ ...base, fetchImpl: async () => { throw new TypeError('fetch failed'); } }), 'unreachable');
  assert.equal(await probeAiService({ url: '', fetchImpl: answering({ status: 'ok' }) }), 'unconfigured');
});

test('a hung AI service cannot hang the health check', async () => {
  const hangs = (url, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const started = Date.now();
  assert.equal(await probeAiService({ url: 'http://ai.test', fetchImpl: hangs, timeoutMs: 50 }), 'unreachable');
  assert.ok(Date.now() - started < 1_000);
});

test('the probe settles on its own deadline even when nothing else keeps Node running', () => {
  // In a separate process, because a test runner may itself keep the event
  // loop alive and hide the fault. The first version used AbortSignal.timeout,
  // whose unref'd timer let this process finish with the probe still pending
  // (exit 13) -- which is how the test above failed on CI's Node 22 and passed
  // on Node 24 here.
  const probe = new URL('../src/services/aiClient.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { probeAiService } from ${JSON.stringify(probe)};
       const hangs = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
       console.log(await probeAiService({ url: 'http://ai.test', fetchImpl: hangs, timeoutMs: 100 }));`,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'unreachable');
});

test('the probe sends the service token and asks the health path', async () => {
  let asked = null;
  await probeAiService({
    url: 'http://ai.test/',
    token: 'service-token',
    fetchImpl: async (url, init) => {
      asked = { url, token: init.headers['X-Service-Token'] };
      return { ok: true, json: async () => ({ status: 'ok' }) };
    },
  });
  assert.deepEqual(asked, { url: 'http://ai.test/health', token: 'service-token' });
});

test('FR-14.1: health reports each dependency independently', async () => {
  await withServer(async (base) => {
    const { status, body } = await call(base, '/api/health');
    assert.equal(status, 200);
    for (const key of ['api', 'database', 'aiService']) {
      assert.ok(key in body, `health is missing ${key}`);
    }
  });
});

test('FR-14.3: a degraded dependency does not make the API unhealthy', async () => {
  // Returning 503 here would take a healthy instance out of a load balancer
  // and turn a partial outage into a total one. The desk still serves tickets,
  // history and the console when the AI service is down.
  await withServer(async (base) => {
    const { status, body } = await call(base, '/api/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'degraded');
    assert.equal(body.api, 'ok');
  });
});

test('unconfigured and unreachable are distinguished', async () => {
  await withServer(async (base) => {
    const { body } = await call(base, '/api/health');
    // With no MONGODB_URI set, the honest answer is "you have not configured
    // this", not "it is refusing connections" -- different problems, different
    // fixes, and collapsing them wastes the first ten minutes of an incident.
    assert.equal(body.database, 'unconfigured');
  });
});
