import test from 'node:test';
import assert from 'node:assert/strict';
import { makeShutdown } from '../src/shutdown.js';

/** Phase 15: SIGTERM stops the API in order, and cannot hang on an open stream. */

function fakes({ openConnections = false, disconnectFails = false } = {}) {
  const events = [];
  let pendingClose = null;
  let timer = null;
  const server = {
    close(callback) {
      events.push('stop accepting');
      if (openConnections) pendingClose = callback;
      else callback();
    },
    closeAllConnections() {
      events.push('close open connections');
      pendingClose?.();
    },
  };
  return {
    events,
    fireTimer: () => timer?.(),
    deps: {
      server,
      disconnect: async () => {
        events.push('disconnect database');
        if (disconnectFails) throw new Error('connection reset');
      },
      exit: (code) => events.push(`exit ${code}`),
      log: () => {},
      setTimer: (fn) => {
        timer = fn;
        return { unref() {} };
      },
      clearTimer: () => (timer = null),
    },
  };
}

test('stops accepting, closes the database, then exits cleanly', async () => {
  const { events, deps } = fakes();
  await makeShutdown(deps)('SIGTERM');
  assert.deepEqual(events, ['stop accepting', 'disconnect database', 'exit 0']);
});

test('a stream still open when the grace period ends is closed, so shutdown cannot hang', async () => {
  const { events, deps, fireTimer } = fakes({ openConnections: true });
  const done = makeShutdown(deps)('SIGTERM');

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['stop accepting'], 'waits while a connection is open');

  fireTimer();
  await done;
  assert.deepEqual(events, ['stop accepting', 'close open connections', 'disconnect database', 'exit 0']);
});

test('a second signal joins the shutdown already under way instead of starting another', async () => {
  const { events, deps } = fakes();
  const shutdown = makeShutdown(deps);
  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
  assert.equal(events.filter((event) => event === 'stop accepting').length, 1);
  assert.equal(events.filter((event) => event.startsWith('exit')).length, 1);
});

test('a failed disconnect exits non-zero, so the platform sees the stop was not clean', async () => {
  const { events, deps } = fakes({ disconnectFails: true });
  await makeShutdown(deps)('SIGTERM');
  assert.equal(events.at(-1), 'exit 1');
});
