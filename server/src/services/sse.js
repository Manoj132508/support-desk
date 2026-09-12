/**
 * Server-sent events, and the relay across the trust boundary.
 *
 * The interesting function here is `relayFrames`, and the interesting thing
 * about it is the allowlist. This is ADR 0002 expressed as code rather than as
 * a diagram: the AI service's output is DATA, not instructions, so Express
 * decides what may cross into the browser rather than forwarding whatever
 * arrives.
 */

/** Frames Express is willing to relay. Anything else is dropped.
 *
 * A pass-through relay would mean the advisory tier could emit a frame name the
 * client happens to act on -- today that is cosmetic, but Phase 10 adds a
 * `proposal` frame that opens a confirmation dialog. On that day, "relay
 * whatever the model's service sent" becomes "let the model open its own
 * authorisation prompt", which is precisely the thing INV-A forbids.
 *
 * So the list is closed now, while it is cheap, rather than after there is
 * something worth exploiting. `proposal` is deliberately ABSENT until Phase 10
 * builds the validation that must accompany it.
 */
export const RELAYABLE_FRAMES = new Set(['token', 'evidence', 'done']);

/** Fields Express will pass on from an `evidence` frame.
 *
 * ADR 0006's amendment: evidence is REFERENCES, never snippets. If the AI
 * service ever sent a `text` or `snippet` field -- through a bug, a refactor,
 * or a prompt-injected response -- forwarding it would put free text into the
 * immutable audit row written downstream, where it can never be scrubbed. The
 * allowlist means that cannot happen by accident.
 */
const EVIDENCE_FIELDS = ['kind', 'ref', 'n', 'documentName', 'section', 'score'];

export function sseFrame(event, data) {
  // JSON-encode even plain strings, so a token containing a newline cannot
  // forge a frame boundary -- the parser on the other side splits on a blank
  // line.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function openSseStream(res) {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx buffers proxied responses by default, which holds tokens back
    // until the response ends -- turning a stream into a slow single reply.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

function sanitiseEvidence(data) {
  const clean = {};
  for (const field of EVIDENCE_FIELDS) {
    if (data?.[field] !== undefined) clean[field] = data[field];
  }
  return clean;
}

/**
 * Relays upstream frames to the client, returning what was seen.
 *
 * Written to take an async iterable and a plain sink so the whole thing is
 * testable without a network, a model, or an HTTP server -- the same seam
 * reasoning as the Python side.
 */
export async function relayFrames(upstream, sink, { onDropped } = {}) {
  const seen = { tokens: [], evidence: [], done: null, dropped: [] };

  for await (const frame of upstream) {
    if (!RELAYABLE_FRAMES.has(frame.event)) {
      seen.dropped.push(frame.event);
      onDropped?.(frame);
      continue;
    }

    if (frame.event === 'evidence') {
      const clean = sanitiseEvidence(frame.data);
      seen.evidence.push(clean);
      sink.write(sseFrame('evidence', clean));
      continue;
    }

    if (frame.event === 'token') {
      seen.tokens.push(frame.data);
      sink.write(sseFrame('token', frame.data));
      continue;
    }

    seen.done = frame.data;
    sink.write(sseFrame('done', frame.data));
  }

  return seen;
}
