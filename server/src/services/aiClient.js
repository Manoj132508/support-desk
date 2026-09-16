import { config } from '../config/env.js';
import { AppError } from '../errors/AppError.js';

/**
 * The only thing in Express that talks to the AI service.
 *
 * Note what this module does NOT export: any way for the AI service to reach
 * the database, the policy engine, or a response. It asks a question and gets
 * text back. The boundary is one-directional by construction (ADR 0002).
 */

/**
 * Parse a buffer into complete SSE frames.
 *
 * The same algorithm as the client's `parseFrames`, and deliberately not
 * shared: this is a server-side parse of an internal service's output, and the
 * client's is a browser parse of ours. Coupling them across a trust boundary
 * would mean a change made for the browser's benefit silently altering how
 * Express reads the advisory tier.
 *
 * `rest` is the incomplete tail. Without it, a frame straddling a chunk
 * boundary is dropped -- the classic SSE bug, where tokens arrive fine until a
 * packet happens to split one.
 */
export function parseFrames(buffer) {
  const normalised = buffer.replace(/\r\n/g, '\n');
  const frames = [];
  let rest = normalised;
  let boundary = rest.indexOf('\n\n');

  while (boundary !== -1) {
    const raw = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);

    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }

    if (dataLines.length) {
      const data = dataLines.join('\n');
      let parsed = data;
      try {
        parsed = JSON.parse(data);
      } catch {
        // A plain-text payload is legal; keep the raw string.
      }
      frames.push({ event, data: parsed });
    }

    boundary = rest.indexOf('\n\n');
  }

  return { frames, rest };
}

/**
 * Streams one advisory turn.
 *
 * `signal` is threaded all the way through so that a customer pressing Stop
 * (FR-1.3) aborts the upstream request rather than leaving the AI service
 * generating tokens nobody will read. Without it, cancellation would only stop
 * the browser listening -- the model would run to completion and the cost would
 * still be paid.
 */
export async function* streamTurn({ question, history = [], correlationId, signal, onResponse }) {
  if (!config.aiServiceUrl) {
    throw AppError.fault('AI service is not configured');
  }

  let response;
  try {
    response = await fetch(`${config.aiServiceUrl.replace(/\/$/, '')}/turn`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Correlation-Id': correlationId ?? '',
        ...(config.aiServiceToken ? { 'X-Service-Token': config.aiServiceToken } : {}),
      },
      body: JSON.stringify({ question, history, correlation_id: correlationId }),
    });
  } catch (error) {
    if (error.name === 'AbortError') return;
    // FR-14.3: the desk degrades to human-only support rather than to a hung
    // UI. An unreachable advisory tier is a fault, and it is Express's fault to
    // report -- never a policy refusal, which would invent a decision nobody
    // made.
    throw AppError.fault(`AI service unreachable: ${error.message}`);
  }

  if (!response.ok || !response.body) {
    throw AppError.fault(`AI service returned ${response.status}`);
  }
  // For turn timing: the AI service has decided what this turn is and begun
  // its stream.
  onResponse?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // `stream: true` keeps a multi-byte character split across two chunks
      // intact; without it a UTF-8 character on a boundary becomes U+FFFD.
      buffer += decoder.decode(value, { stream: true });

      const { frames, rest } = parseFrames(buffer);
      buffer = rest;
      for (const frame of frames) yield frame;
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
