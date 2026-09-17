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

/** A health check must answer quickly even when what it checks does not. */
export const AI_HEALTH_TIMEOUT_MS = 1_500;

/**
 * Is the AI service answering? For /api/health (FR-14.1).
 *
 * Until Phase 14 health never asked: it reported `unreachable` whenever a URL
 * was configured, including while the service was answering turns. Found by
 * running the whole stack for the first time.
 *
 * Never throws, and gives up after a short timeout, so a hung advisory tier
 * cannot hang the health check that is meant to report it.
 *
 * The timeout is an ordinary timer, cleared when the probe settles, not
 * `AbortSignal.timeout()`. That one's timer is unref'd: it does not keep Node's
 * event loop alive, so a probe with nothing else pending can find the process
 * finished before its deadline arrives. Inside a running server something is
 * always pending; in the Node 22 test runner on CI nothing was, and the probe's
 * hung-service test failed there while passing on Node 24 locally (Phase 15).
 *
 *   unconfigured  no AI_SERVICE_URL
 *   ok            answered, with its embedder loaded
 *   starting      answered, still loading
 *   unreachable   no answer, an error status, a malformed body, or too slow
 */
export async function probeAiService({
  url = config.aiServiceUrl,
  token = config.aiServiceToken,
  fetchImpl = fetch,
  timeoutMs = AI_HEALTH_TIMEOUT_MS,
} = {}) {
  if (!url) return 'unconfigured';
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('AI service health check timed out')), timeoutMs);
  try {
    const response = await fetchImpl(`${url.replace(/\/$/, '')}/health`, {
      headers: token ? { 'X-Service-Token': token } : {},
      signal: controller.signal,
    });
    if (!response.ok) return 'unreachable';
    const body = await response.json();
    return body?.status === 'ok' ? 'ok' : 'starting';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(deadline);
  }
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
