/**
 * Server-sent events, and the relay across the trust boundary.
 *
 * The interesting function here is `relayFrames`, and the interesting thing
 * about it is the allowlist. This is ADR 0002 expressed as code rather than as
 * a diagram: the AI service's output is DATA, not instructions, so Express
 * decides what may cross into the browser rather than forwarding whatever
 * arrives.
 */

/** Frames Express is willing to RELAY. Anything else is dropped.
 *
 * A pass-through relay would mean the advisory tier could emit a frame name the
 * client acts on. The browser's `proposal` frame opens a confirmation dialog;
 * if upstream frames named `proposal` were forwarded, the model could open its
 * own authorisation prompt -- precisely the thing INV-A forbids.
 *
 * So `proposal` is NOT in this list, and never will be. Express emits that
 * frame itself, after validation (see INTERCEPTED_FRAMES). Phase 9 closed this
 * list while it was cheap; Phase 10 kept it closed.
 */
export const RELAYABLE_FRAMES = new Set(['token', 'evidence', 'done']);

/**
 * Frames Express INTERCEPTS: consumed here, never forwarded.
 *
 * `proposal_request` carries the advisory tier's RAW proposal. It goes to a
 * handler that runs it through the boundary, the engine and the audit, and the
 * handler's output -- not the raw proposal -- is what the browser receives. The
 * upstream name deliberately differs from the downstream one, so no single
 * relay mistake can connect them.
 */
export const INTERCEPTED_FRAMES = new Set(['proposal_request']);

/** What an interception handler may put into the customer's stream. */
const HANDLER_EVENTS = new Set(['proposal', 'policy']);

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
 *
 * `onProposalRequest(raw)` is optional. Without it -- a staff member's turn, for
 * instance, which may not raise a proposal -- a `proposal_request` is DROPPED,
 * exactly like any other frame Express does not accept. With it, the handler's
 * returned frames are written instead of the raw request.
 *
 * AT MOST ONE PROPOSAL PER TURN. ADR 0009 property 7: one proposal, one dialog.
 * A second `proposal_request` in the same turn is dropped rather than stacking
 * confirmations in front of the customer.
 */
export async function relayFrames(upstream, sink, { onDropped, onProposalRequest } = {}) {
  const seen = { tokens: [], evidence: [], done: null, dropped: [], intercepted: 0 };

  const drop = (frame) => {
    seen.dropped.push(frame.event);
    onDropped?.(frame);
  };

  for await (const frame of upstream) {
    if (INTERCEPTED_FRAMES.has(frame.event)) {
      if (!onProposalRequest || seen.intercepted >= 1) {
        drop(frame);
        continue;
      }
      seen.intercepted += 1;

      const emitted = await onProposalRequest(frame.data);
      for (const out of emitted ?? []) {
        if (!HANDLER_EVENTS.has(out?.event)) {
          // A programming error in a handler, not a data condition: it would
          // mean Express itself was about to put something other than a
          // validated proposal or a policy notice into the customer's stream.
          throw new Error(`An interception handler may not emit "${out?.event}"`);
        }
        sink.write(sseFrame(out.event, out.data));
      }
      continue;
    }

    if (!RELAYABLE_FRAMES.has(frame.event)) {
      drop(frame);
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
