import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTurnTimer, TURN_MARKS } from '../src/services/turnTiming.js';
import { relayFrames } from '../src/services/sse.js';
import { streamTurn } from '../src/services/aiClient.js';
import { config } from '../src/config/env.js';

/**
 * NFR-1's instrumentation. A latency log that measured from the wrong moment,
 * or let a later token overwrite the first, would report a time to first token
 * nobody experienced -- and nothing would look wrong.
 */

function fakeClock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test('marks are measured from the request’s arrival, not from when the timer was made', () => {
  const clock = fakeClock();
  const arrivedAt = clock.now();
  clock.advance(40); // authentication and the rate limiter ran first
  const timer = makeTurnTimer({ startedAt: arrivedAt, now: clock.now });

  clock.advance(10);
  timer.mark('persisted');

  assert.equal(timer.summary().persistedMs, 50);
});

test('the first mark of a name wins, so a later token cannot become the first token', () => {
  const clock = fakeClock();
  const timer = makeTurnTimer({ now: clock.now });
  clock.advance(700);
  timer.mark('firstToken');
  clock.advance(900);
  timer.mark('firstToken');

  assert.equal(timer.summary().firstTokenMs, 700);
});

test('a stage that never happened is null, not zero', () => {
  const summary = makeTurnTimer({ now: fakeClock().now }).summary();
  assert.deepEqual(Object.keys(summary), TURN_MARKS.map((name) => `${name}Ms`));
  assert.ok(Object.values(summary).every((value) => value === null));
});

test('a misspelt mark throws instead of silently recording nothing', () => {
  assert.throws(() => makeTurnTimer().mark('firstTokn'), /Unknown turn timing mark/);
});

test('durations are rounded to a tenth of a millisecond', () => {
  const clock = fakeClock(0);
  const timer = makeTurnTimer({ startedAt: 0, now: clock.now });
  clock.advance(12.3456);
  timer.mark('finished');
  assert.equal(timer.summary().finishedMs, 12.3);
});

async function* upstream(frames) {
  for (const frame of frames) yield frame;
}

test('the relay reports every frame it writes, by event name only, in order', async () => {
  const written = [];
  await relayFrames(
    upstream([
      { event: 'evidence', data: { kind: 'kb_chunk', ref: 'doc:1' } },
      { event: 'not_allowed', data: {} },
      { event: 'token', data: 'Hi' },
      { event: 'proposal_request', data: { actionType: 'order.cancel' } },
      { event: 'done', data: {} },
    ]),
    { write: () => {} },
    {
      onProposalRequest: async () => [{ event: 'proposal', data: { id: 'p1' } }],
      onWrite: (...args) => written.push(args),
    },
  );

  // A dropped frame reached nobody, so it is not reported as written.
  assert.deepEqual(written, [['evidence'], ['token'], ['proposal'], ['done']]);
});

test('the AI service counts as having responded only once its stream is actually open', async (t) => {
  config.aiServiceUrl = 'http://ai.test';
  let responded = 0;

  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 503, body: null }));
  await assert.rejects(async () => {
    for await (const frame of streamTurn({ question: 'q', onResponse: () => (responded += 1) })) void frame;
  });
  assert.equal(responded, 0, 'a failed response is not a response for timing');

  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    body: new ReadableStream({ start: (controller) => controller.close() }),
  }));
  for await (const frame of streamTurn({ question: 'q', onResponse: () => (responded += 1) })) void frame;
  assert.equal(responded, 1);
});
