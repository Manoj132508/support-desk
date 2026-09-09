import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, call } from './helpers.js';

test('every response carries a correlation id', async () => {
  await withServer(async (base) => {
    const { response, body } = await call(base, '/api/health');
    assert.ok(response.headers.get('x-correlation-id'));
    assert.equal(body.correlationId, response.headers.get('x-correlation-id'));
  });
});

test('a caller-supplied correlation id is echoed', async () => {
  await withServer(async (base) => {
    const { response } = await call(base, '/api/health', {
      headers: { 'X-Correlation-Id': 'trace-abc-123' },
    });
    assert.equal(response.headers.get('x-correlation-id'), 'trace-abc-123');
  });
});

test('a hostile correlation id is replaced, not echoed', async () => {
  // The value is client-supplied and ends up in log lines. Echoing a newline
  // would let a caller forge log entries.
  await withServer(async (base) => {
    const { response } = await call(base, '/api/health', {
      headers: { 'X-Correlation-Id': 'abc injected' },
    });
    const echoed = response.headers.get('x-correlation-id');
    assert.notEqual(echoed, 'abc injected');
    assert.match(echoed, /^[A-Za-z0-9-]{36}$/, 'should fall back to a generated UUID');
  });
});

test('an over-long correlation id is replaced', async () => {
  await withServer(async (base) => {
    const { response } = await call(base, '/api/health', {
      headers: { 'X-Correlation-Id': 'a'.repeat(200) },
    });
    assert.match(response.headers.get('x-correlation-id'), /^[A-Za-z0-9-]{36}$/);
  });
});

test('errors carry the correlation id too', async () => {
  await withServer(async (base) => {
    const { body } = await call(base, '/api/missing', {
      headers: { 'X-Correlation-Id': 'trace-err-1' },
    });
    assert.equal(body.correlationId, 'trace-err-1');
  });
});
