/**
 * The four-kind error taxonomy (Phase 2 section 5), server side.
 *
 * The client has a mirror of this in `lib/outcomes.js`. Keeping both is
 * deliberate: the server decides which kind a failure IS, the client decides
 * how a kind LOOKS. Neither should be inferring the other's job from a status
 * code.
 *
 * Three of the four are normal outcomes of a working system. Only `fault` is a
 * bug, and only `fault` is worth waking someone up for.
 */

export const KIND = {
  MALFORMED: 'malformed',
  REFUSED: 'refused',
  STALE: 'stale',
  FAULT: 'fault',
};

const STATUS_BY_KIND = {
  [KIND.MALFORMED]: 422,
  [KIND.REFUSED]: 403,
  [KIND.STALE]: 409,
  [KIND.FAULT]: 500,
};

export class AppError extends Error {
  constructor(kind, { message, customerMessage, detail, status, expected } = {}) {
    super(message ?? kind);
    this.name = 'AppError';
    this.kind = kind;
    this.status = status ?? STATUS_BY_KIND[kind] ?? 500;
    /** Plain, rule-authored text safe to show a customer (ADR 0007). */
    this.customerMessage = customerMessage ?? null;
    /** Rule key, version, matched conditions. Stripped for customer callers. */
    this.detail = detail ?? null;
    /**
     * Faults are bugs; the other three are not. Drives whether a stack is
     * logged. Overridable because a few `fault`-kinded responses are known,
     * deliberate states rather than bugs -- see `notFound` and
     * `notImplemented` below.
     */
    this.expected = expected ?? kind !== KIND.FAULT;
  }

  static malformed(message, options) {
    return new AppError(KIND.MALFORMED, { message, ...options });
  }

  static refused(message, options) {
    return new AppError(KIND.REFUSED, { message, ...options });
  }

  static stale(message, options) {
    return new AppError(KIND.STALE, { message, ...options });
  }

  static fault(message, options) {
    return new AppError(KIND.FAULT, { message, ...options });
  }

  /**
   * Not found — and deliberately the most boring error in the system.
   *
   * INV-D requires a record belonging to another tenant to be
   * INDISTINGUISHABLE from one that does not exist. That is not only about the
   * status code: if a 404 carried a policy kind, a customerMessage, or any
   * detail, the response body would differ between the two cases and the
   * isolation would leak through the error payload.
   *
   * So every 404 in this system is byte-identical and says nothing. It takes
   * no arguments on purpose -- there is no way for a caller to accidentally
   * make one informative.
   */
  static notFound() {
    return new AppError(KIND.FAULT, { message: 'Not found', status: 404, expected: true });
  }

  /**
   * A route that exists in the contract but is built by a later phase.
   *
   * Returning a shaped 501 rather than omitting the route means the contract
   * is testable now, and a half-built route cannot quietly pass for a finished
   * one.
   */
  static notImplemented(phase) {
    return new AppError(KIND.FAULT, {
      message: `Not implemented yet — built in ${phase}`,
      status: 501,
      // Deliberately `expected`. Found by running the suite: without this,
      // every unbuilt route logged a full stack trace, so a normal test run
      // produced fourteen alarming multi-line errors for a system behaving
      // exactly as designed. A log that cries wolf on purpose teaches everyone
      // to stop reading it -- which is the same failure mode as rendering a
      // policy refusal as a red error toast, one layer down.
      expected: true,
    });
  }
}
