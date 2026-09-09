import rateLimit from 'express-rate-limit';
import { AppError } from '../errors/AppError.js';

/**
 * NFR-3. Two limiters, for two different reasons.
 *
 * A rate-limit rejection is routed through `next()` into the error envelope
 * rather than being sent by the library, so a 429 has the same shape as every
 * other error. A client that has to special-case one response shape will
 * eventually special-case it wrongly.
 *
 * The kind is `fault`, not `refused`. `refused` means a POLICY RULE declined an
 * action, and it renders in the policy language. A rate limit is infrastructure
 * pushing back, and calling it a refusal would put non-decisions into the
 * mental model -- and eventually into the audit -- that the policy language is
 * meant to describe.
 */

function envelopeHandler(req, res, next) {
  next(
    new AppError('fault', {
      message: 'Too many requests',
      status: 429,
    }),
  );
}

const shared = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: envelopeHandler,
};

/** Auth: the routes an attacker hammers. */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60 * 1000,
  limit: 20,
});

/**
 * Confirm: the only route that mutates business data.
 *
 * Limited generously -- a real customer confirms one action, occasionally two.
 * Anything approaching this ceiling is a retry loop or an attack, and either
 * way it should be slowed down rather than served.
 */
export const confirmLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 10,
});
