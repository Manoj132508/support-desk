import { randomUUID } from 'node:crypto';

const HEADER = 'x-correlation-id';

/**
 * One id per request, threaded everywhere.
 *
 * ADR 0001 put the model behind a process boundary, which is what makes INV-A
 * an architectural property. The cost is that a single conversational turn now
 * spans two runtimes, and without a shared id the boundary that provides the
 * safety also destroys the ability to debug it -- you get two log streams and
 * no way to line them up.
 *
 * Echoed from the caller when present so a browser-reported id can be traced
 * end to end, generated otherwise. Returned on every response and included in
 * every error envelope, so a user reporting a problem can quote one string
 * that finds the exact request.
 *
 * The echoed value is length-capped and character-restricted: it is
 * client-supplied and it ends up in log lines, so it must not be able to carry
 * newlines and forge log entries.
 */
export function correlationId(req, res, next) {
  const supplied = req.get(HEADER);
  const safe =
    typeof supplied === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(supplied)
      ? supplied
      : randomUUID();

  req.correlationId = safe;
  res.set('X-Correlation-Id', safe);
  next();
}
