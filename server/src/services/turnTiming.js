import { performance } from 'node:perf_hooks';

/**
 * Where the time goes in a streaming turn. NFR-1, Phase 14.
 *
 * Phase 1 §6 asks for time to first token to be "instrumented in the streaming
 * path", and a single number would not say what to fix. So a turn records the
 * moment each stage finished, measured from when the request ARRIVED -- before
 * authentication, which reads the user from the database on every request, and
 * before the rate limiter. A clock started in the route handler would leave
 * that out and report a latency no customer experiences.
 *
 *   persisted          the customer's question is saved and the history read
 *   streamOpened       response headers are sent
 *   upstreamResponded  the AI service has answered with its stream's headers
 *   firstFrame         the first frame reached the customer's connection
 *   firstToken         the first TOKEN reached it, which is what NFR-1 names
 *   finished           the stream is complete
 *
 * The first mark of each name wins, so "firstToken" can only ever mean the
 * first. Timestamps come from a monotonic clock: a wall clock can step
 * backwards and produce a negative latency.
 */
export const TURN_MARKS = Object.freeze([
  'persisted',
  'streamOpened',
  'upstreamResponded',
  'firstFrame',
  'firstToken',
  'finished',
]);

export function makeTurnTimer({ startedAt, now = () => performance.now() } = {}) {
  const origin = typeof startedAt === 'number' ? startedAt : now();
  const marks = new Map();

  return {
    mark(name) {
      if (!TURN_MARKS.includes(name)) throw new Error(`Unknown turn timing mark "${name}"`);
      if (!marks.has(name)) marks.set(name, now() - origin);
    },
    has(name) {
      return marks.has(name);
    },
    /** Milliseconds since arrival for each mark, to 0.1 ms; null when a stage never happened. */
    summary() {
      return Object.fromEntries(
        TURN_MARKS.map((name) => [`${name}Ms`, marks.has(name) ? Math.round(marks.get(name) * 10) / 10 : null]),
      );
    },
  };
}
