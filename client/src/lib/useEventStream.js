import { useCallback, useEffect, useRef, useState } from 'react';
import { csrfHeaders } from './api.js';

/**
 * Server-sent events over fetch, with cancellation.
 *
 * WHY NOT `EventSource`? The browser's built-in SSE client only does GET, and
 * cannot set headers. We need POST (the message is a body, not a query string)
 * and we need the CSRF header. So the transport is `fetch` + a ReadableStream
 * reader, and we parse the wire format ourselves. That is the same choice
 * Projects 1 and 2 made, and this is that code ported.
 *
 * Cancellation is FR-1.3 and is the part people get wrong: `AbortController`
 * aborts the fetch, which rejects the reader, which we catch and treat as a
 * NORMAL terminal state -- not an error. A user stopping a response has not
 * hit a bug, and rendering one would be a lie about what happened.
 */

/**
 * Split a buffer into complete SSE frames.
 *
 * Exported and pure so it can be tested exhaustively without a network, a
 * server, or a fake ReadableStream. The parser is the part with edge cases
 * (split frames, multi-line data, comments); the network plumbing is not.
 *
 * A frame is terminated by a blank line. Anything after the last blank line is
 * an INCOMPLETE frame -- it is returned as `rest` and prepended to the next
 * chunk. Forgetting that is the classic SSE bug: tokens arrive fine until a
 * network packet happens to split one frame across two chunks.
 */
export function parseFrames(buffer) {
  // The spec allows CRLF; normalising once here means the rest of the parser
  // only ever deals with \n.
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
      if (line.startsWith(':')) continue; // comment / keep-alive
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }

    if (dataLines.length > 0) {
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

export const STREAM_STATUS = {
  IDLE: 'idle',
  STREAMING: 'streaming',
  COMPLETE: 'complete',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

export function useEventStream() {
  const [status, setStatus] = useState(STREAM_STATUS.IDLE);
  const [error, setError] = useState(null);
  const controllerRef = useRef(null);

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  /**
   * Abort any in-flight stream when the component unmounts.
   *
   * Without this, navigating away mid-response leaves the fetch running and
   * its handlers calling setState on an unmounted component -- a leak that
   * shows up as a console warning and, in a long session, as real memory.
   */
  useEffect(() => () => controllerRef.current?.abort(), []);

  const start = useCallback(async (path, body, handlers = {}) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setStatus(STREAM_STATUS.STREAMING);
    setError(null);

    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...csrfHeaders(),
        },
        body: JSON.stringify(body ?? {}),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Stream failed to open (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // `stream: true` keeps a multi-byte character split across two chunks
        // intact. Without it, a UTF-8 character on a chunk boundary decodes to
        // a replacement character.
        buffer += decoder.decode(value, { stream: true });

        const { frames, rest } = parseFrames(buffer);
        buffer = rest;

        for (const frame of frames) {
          handlers[frame.event]?.(frame.data);
        }
      }

      setStatus(STREAM_STATUS.COMPLETE);
      handlers.complete?.();
    } catch (err) {
      // A cancelled stream is a normal terminal state, not a failure.
      if (err.name === 'AbortError') {
        setStatus(STREAM_STATUS.CANCELLED);
        handlers.cancelled?.();
        return;
      }
      setStatus(STREAM_STATUS.FAILED);
      setError(err);
      handlers.failed?.(err);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, []);

  return { start, stop, status, error };
}
