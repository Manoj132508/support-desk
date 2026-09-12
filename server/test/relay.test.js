import test from 'node:test';
import assert from 'node:assert/strict';
import { relayFrames, sseFrame, RELAYABLE_FRAMES } from '../src/services/sse.js';
import { parseFrames } from '../src/services/aiClient.js';

/**
 * The trust boundary, as tests.
 *
 * ADR 0002 says the advisory tier's output is data, not instructions. These
 * assert that Express actually behaves that way -- which is the difference
 * between an invariant and a diagram.
 */

function fakeSink() {
  const written = [];
  return { written, write: (chunk) => written.push(chunk) };
}

async function* upstream(frames) {
  for (const frame of frames) yield frame;
}

test('tokens and evidence are relayed', async () => {
  const sink = fakeSink();
  const seen = await relayFrames(
    upstream([
      { event: 'evidence', data: { kind: 'kb_chunk', ref: 'doc:1', n: 1 } },
      { event: 'token', data: 'Hello' },
      { event: 'token', data: ' there' },
      { event: 'done', data: { grounded: true } },
    ]),
    sink,
  );

  assert.deepEqual(seen.tokens, ['Hello', ' there']);
  assert.equal(seen.evidence.length, 1);
  assert.deepEqual(seen.done, { grounded: true });
  assert.equal(sink.written.length, 4);
});

test('ADR 0002: a frame Express does not permit is DROPPED, not forwarded', async () => {
  // A pass-through relay would let the advisory tier emit a frame the client
  // acts on. Today that is cosmetic; in Phase 10 a `proposal` frame opens a
  // confirmation dialog, and "forward whatever the model's service sent" would
  // become "let the model open its own authorisation prompt".
  const sink = fakeSink();
  const dropped = [];

  const seen = await relayFrames(
    upstream([
      { event: 'token', data: 'ok' },
      { event: 'proposal', data: { actionType: 'order.cancel', orderId: '1043' } },
      { event: 'execute', data: { orderId: '1043' } },
      { event: 'done', data: {} },
    ]),
    sink,
    { onDropped: (frame) => dropped.push(frame.event) },
  );

  assert.deepEqual(seen.dropped, ['proposal', 'execute']);
  assert.deepEqual(dropped, ['proposal', 'execute']);
  const body = sink.written.join('');
  assert.ok(!body.includes('proposal'), 'a proposal frame must not reach the browser yet');
  assert.ok(!body.includes('execute'));
});

test('proposal is deliberately absent from the allowlist until Phase 10', () => {
  // Closed now, while it is cheap, rather than after there is something worth
  // exploiting. Phase 10 adds it together with the validation that must
  // accompany it.
  assert.equal(RELAYABLE_FRAMES.has('proposal'), false);
  assert.deepEqual([...RELAYABLE_FRAMES].sort(), ['done', 'evidence', 'token']);
});

test('ADR 0006: a snippet on an evidence frame is stripped, not relayed', async () => {
  // Free text would end up in the immutable audit row written downstream,
  // where it can never be scrubbed. The allowlist means a bug, a refactor or a
  // prompt-injected response cannot put it there.
  const sink = fakeSink();
  const seen = await relayFrames(
    upstream([
      {
        event: 'evidence',
        data: {
          kind: 'kb_chunk',
          ref: 'doc:1',
          text: 'the customer said their card number is ...',
          snippet: 'more free text',
        },
      },
    ]),
    sink,
  );

  assert.equal(seen.evidence[0].ref, 'doc:1');
  assert.equal(seen.evidence[0].text, undefined);
  assert.equal(seen.evidence[0].snippet, undefined);
  assert.ok(!sink.written.join('').includes('card number'));
});

test('a token containing a newline cannot forge a frame boundary', () => {
  // The parser on the other side splits on a blank line, so an unencoded
  // newline in a token would let generated text inject a frame.
  const frame = sseFrame('token', 'line one\n\nevent: done\ndata: {}');
  const { frames } = parseFrames(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].event, 'token');
});

test('the upstream parser reassembles a frame split across chunks', () => {
  const first = parseFrames('event: token\ndata: "he');
  assert.equal(first.frames.length, 0);
  const second = parseFrames(first.rest + 'llo"\n\n');
  assert.deepEqual(second.frames, [{ event: 'token', data: 'hello' }]);
});

test('the upstream parser handles CRLF and comments', () => {
  const { frames } = parseFrames(': keep-alive\r\nevent: token\r\ndata: "a"\r\n\r\n');
  assert.deepEqual(frames, [{ event: 'token', data: 'a' }]);
});

test('relaying an empty stream yields nothing and does not throw', async () => {
  const sink = fakeSink();
  const seen = await relayFrames(upstream([]), sink);
  assert.deepEqual(seen.tokens, []);
  assert.equal(seen.done, null);
  assert.equal(sink.written.length, 0);
});
