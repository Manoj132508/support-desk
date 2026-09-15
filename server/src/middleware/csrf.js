import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors/AppError.js';
import { CSRF_COOKIE, CSRF_HEADER } from '../auth/cookies.js';

/**
 * Double-submit cookie CSRF protection. Ported from Project 2.
 *
 * Cookie auth needs this because the browser attaches our session cookie to
 * requests it makes on our behalf -- including ones initiated by another site.
 * On login we set a second, non-httpOnly cookie holding a random token; the
 * client echoes it in the X-CSRF-Token header on every unsafe request, and we
 * require the two to match. An attacker's page can send the session cookie but
 * cannot READ the CSRF cookie to produce the header (same-origin policy).
 * Paired with SameSite=Strict as a second, independent layer.
 *
 * WHY THIS MATTERS MORE IN THIS PROJECT. Project 2's worst CSRF outcome was an
 * unwanted document. Here, the protected set includes
 * `POST /api/proposals/:id/confirm` -- the one route that mutates business
 * data. A CSRF hole would let another site cause a real cancellation using a
 * customer's own session, which is precisely the "action nobody authorised"
 * that INV-A exists to prevent. The invariant is enforced in the policy engine;
 * this is the layer that ensures the CONFIRMATION itself was genuine.
 */

// Safe methods do not change state, so need no token. Not laziness: a GET that
// mutates is the actual bug, and CSRF-protecting it would hide it.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so the length check comes first.
  // It leaks length, which is fine for a random token of fixed size.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireCsrfToken(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);

  if (!cookieToken || !headerToken || !safeCompare(cookieToken, headerToken)) {
    // A security event worth a line in the log -- but a line, not a stack
    // trace: a forged request is the defence working, not a bug (Phase 12).
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'csrf_rejected',
        path: req.originalUrl ?? null,
        userId: req.user?.id ?? null,
        correlationId: req.correlationId ?? null,
      }),
    );
    // `fault`, not `refused`. A refusal means a POLICY RULE declined an action
    // and renders in the policy language; a failed CSRF check means the request
    // was not genuine, which is not a decision about anything.
    return next(
      new AppError('fault', { message: 'CSRF token missing or invalid', status: 403, expected: true }),
    );
  }

  return next();
}
