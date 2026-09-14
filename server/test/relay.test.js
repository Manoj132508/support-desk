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

test('the browser’s proposal frame is NEVER relayed from upstream — Express emits its own', () => {
  // Phase 9 closed this list while it was cheap. Phase 10 kept it closed: the
  // advisory tier's raw proposal arrives under a different name and is
  // intercepted, so there is no relay path by which the model could open its
  // own confirmation dialog.
  assert.equal(RELAYABLE_FRAMES.has('proposal'), false);
  assert.equal(RELAYABLE_FRAMES.has('proposal_request'), false);
  assert.deepEqual([...RELAYABLE_FRAMES].sort(), ['done', 'evidence', 'token']);
});

test('a proposal_request is INTERCEPTED: the handler’s frames go out, the raw proposal never does', async () => {
  const sink = fakeSink();
  const received = [];

  const seen = await relayFrames(
    upstream([
      { event: 'token', data: 'Let me check that order.' },
      {
        event: 'proposal_request',
        data: { actionType: 'order.cancel', target: { kind: 'order', orderNumber: '1043' }, authorised: true },
      },
      { event: 'done', data: {} },
    ]),
    sink,
    {
      onProposalRequest: async (raw) => {
        received.push(raw);
        return [{ event: 'policy', data: { kind: 'malformed', customerMessage: null } }];
      },
    },
  );

  assert.equal(received.length, 1, 'the handler sees the raw proposal');
  assert.equal(seen.intercepted, 1);
  const body = sink.written.join('');
  assert.ok(body.includes('event: policy'), 'the handler’s frame is written');
  assert.ok(!body.includes('proposal_request'), 'the raw event name never reaches the browser');
  assert.ok(!body.includes('authorised'), 'nothing from the raw proposal is forwarded');
});

test('with no handler — a staff turn — a proposal_request is dropped like any unaccepted frame', async () => {
  const sink = fakeSink();
  const dropped = [];
  const seen = await relayFrames(
    upstream([{ event: 'proposal_request', data: { actionType: 'order.cancel' } }]),
    sink,
    { onDropped: (frame) => dropped.push(frame.event) },
  );
  assert.deepEqual(seen.dropped, ['proposal_request']);
  assert.deepEqual(dropped, ['proposal_request']);
  assert.equal(sink.written.length, 0);
});

test('ADR 0009: at most one proposal per turn — a second request is dropped, not stacked', async () => {
  const sink = fakeSink();
  let calls = 0;
  const seen = await relayFrames(
    upstream([
      { event: 'proposal_request', data: { n: 1 } },
      { event: 'proposal_request', data: { n: 2 } },
    ]),
    sink,
    {
      onProposalRequest: async () => {
        calls += 1;
        return [{ event: 'proposal', data: { id: 'p1' } }];
      },
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(seen.dropped, ['proposal_request']);
  assert.equal(sink.written.filter((chunk) => chunk.startsWith('event: proposal')).length, 1);
});

test('an interception handler cannot put anything but a proposal or policy frame into the stream', async () => {
  await assert.rejects(
    relayFrames(upstream([{ event: 'proposal_request', data: {} }]), fakeSink(), {
      onProposalRequest: async () => [{ event: 'execute', data: { orderId: '1043' } }],
    }),
    /may not emit "execute"/,
  );
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
