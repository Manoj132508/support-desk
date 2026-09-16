/**
 * Stopping cleanly when the platform asks. Phase 15.
 *
 * `docker stop`, and every orchestrator after it, sends SIGTERM and waits a
 * grace period before killing the process. Before this, nothing handled the
 * signal: the API was killed mid-request, and the database connection was
 * dropped rather than closed.
 *
 * The order matters:
 *
 *   1. Stop accepting connections, and let requests in flight finish.
 *   2. After `graceMs`, close whatever is still open. A streaming turn can stay
 *      open for as long as the model generates, and a customer's stream closing
 *      is already handled: the route aborts the AI service call and records the
 *      turn as cancelled (FR-1.3), exactly as when the customer presses Stop.
 *   3. Close the database connection, then exit.
 *
 * Nothing here needs to protect a confirmation half-done. Execution is one
 * transaction (Phase 3 §9), so a process that dies inside it leaves nothing
 * half-written: the server aborts the transaction, and the idempotency key lets
 * the customer's retry settle it (ADR 0003).
 */
export const SHUTDOWN_GRACE_MS = 10_000;

export function makeShutdown({
  server,
  disconnect,
  exit,
  log = (entry) => console.log(JSON.stringify(entry)),
  graceMs = SHUTDOWN_GRACE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let stopping = null;

  return function shutdown(signal) {
    // A second signal -- an impatient Ctrl+C -- must not start a second,
    // overlapping shutdown.
    if (stopping) return stopping;

    stopping = (async () => {
      log({ level: 'info', message: 'Shutting down', signal });

      const forced = setTimer(() => {
        log({ level: 'warn', message: 'Grace period over: closing connections still open', graceMs });
        server.closeAllConnections?.();
      }, graceMs);
      forced?.unref?.();

      await new Promise((resolve) => server.close(() => resolve()));
      clearTimer(forced);

      try {
        await disconnect();
      } catch (error) {
        log({ level: 'error', message: 'Database disconnect failed during shutdown', error: error.message });
        exit(1);
        return;
      }
      log({ level: 'info', message: 'Shut down cleanly', signal });
      exit(0);
    })();

    return stopping;
  };
}
