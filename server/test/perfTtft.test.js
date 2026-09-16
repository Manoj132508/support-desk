import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalBase, makeCookieJar, observedKind, summariseTurns, TURNS } from '../perf/ttft.js';

/** The time-to-first-token harness's own logic, without a running stack. */

test('it refuses to sign in anywhere but this machine, because the seed password is published', () => {
  assert.doesNotThrow(() => assertLocalBase('http://localhost:5179'));
  assert.doesNotThrow(() => assertLocalBase('http://127.0.0.1:4400'));
  assert.throws(() => assertLocalBase('https://support.example.com'), /only in development/);
  assert.throws(() => assertLocalBase('http://localhost.example.com'), /only in development/);
});

test('the cookie jar keeps name and value and drops the attributes', () => {
  const jar = makeCookieJar();
  jar.store(['asd_session=abc.def; Path=/; HttpOnly; SameSite=Lax', 'asd_csrf=token-1; Path=/']);
  assert.equal(jar.get('asd_csrf'), 'token-1');
  assert.equal(jar.header(), 'asd_session=abc.def; asd_csrf=token-1');
});

test('the kind a customer experienced comes from the final frame, in the eval’s vocabulary', () => {
  assert.equal(observedKind({ action: 'propose', grounded: false }), 'propose');
  assert.equal(observedKind({ action: null, grounded: true }), 'answered');
  assert.equal(observedKind({ action: null, grounded: false }), 'offered_person');
  assert.equal(observedKind(null), null);
});

test('fast static turns cannot hide slow answers: each kind gets its own verdict', () => {
  const samples = [
    ...Array.from({ length: 19 }, () => ({ kind: 'offered_person', firstTokenMs: 120 })),
    { kind: 'answered', firstTokenMs: 9_000 },
  ];
  const summary = summariseTurns(samples);

  assert.equal(summary.overall.meetsBudget, true, 'pooled, the one slow answer is below p95');
  assert.equal(summary.byKind.answered.meetsBudget, false);
  assert.equal(summary.byKind.offered_person.meetsBudget, true);
});

test('a turn that produced no token is counted as failed, not as fast', () => {
  const summary = summariseTurns([
    { kind: 'answered', firstTokenMs: 800 },
    { kind: null, firstTokenMs: null },
  ]);
  assert.equal(summary.failed, 1);
  assert.equal(summary.overall.n, 1);
});

test('the turn mix covers every kind of turn, with the model-calling kind the most sampled', () => {
  const counts = TURNS.reduce((tally, turn) => ({ ...tally, [turn.expected]: (tally[turn.expected] ?? 0) + 1 }), {});
  assert.deepEqual(Object.keys(counts).sort(), ['answered', 'ask_order_number', 'offered_person', 'propose']);
  assert.ok(counts.answered > counts.offered_person);
});

test('some answers are followed up in the same conversation, because history changes the prompt', () => {
  const followed = TURNS.filter((turn) => turn.followUp);
  assert.ok(followed.length >= 2);
  assert.ok(followed.every((turn) => turn.expected === 'answered'));
});

test('a follow-up is summarised apart from first turns', () => {
  const summary = summariseTurns([
    { kind: 'answered', firstTokenMs: 900 },
    { kind: 'answered (follow-up)', firstTokenMs: 2_100 },
  ]);
  assert.deepEqual(Object.keys(summary.byKind).sort(), ['answered', 'answered (follow-up)']);
});
