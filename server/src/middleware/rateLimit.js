import rateLimit from 'express-rate-limit';
import { AppError } from '../errors/AppError.js';

/**
 * NFR-3, and OWASP API4 (unrestricted resource consumption).
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
 *
 * Three things changed in Phase 12:
 *
 *   1. A rejection is `expected`. It was not, so every 429 logged a full stack
 *      trace -- the log that cries wolf Phase 6 had already fixed for 404s and
 *      501s, missed here.
 *   2. Each rejection is logged once as a structured security event instead,
 *      without the client's address.
 *   3. Limiters on signed-in routes key on the USER, not the address. Customers
 *      behind one office network share an address and should not throttle each
 *      other; someone with many addresses still has only one session.
 */

function handlerFor(name) {
  return (req, res, next) => {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'rate_limited',
        limiter: name,
        path: req.originalUrl ?? null,
        userId: req.user?.id ?? null,
        correlationId: req.correlationId ?? null,
      }),
    );
    next(new AppError('fault', { message: 'Too many requests', status: 429, expected: true }));
  };
}

/** Signed-in callers are counted per user; anyone else by address. */
export function perUser(req) {
  return req.user?.id ? `user:${req.user.id}` : `ip:${req.ip}`;
}

export function makeLimiter({ name, windowMs, limit, keyGenerator }) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    windowMs,
    limit,
    handler: handlerFor(name),
    // Only when given: an explicit `undefined` would replace the library's
    // default key rather than fall back to it.
    ...(keyGenerator ? { keyGenerator } : {}),
  });
}

/** Auth: the routes an attacker hammers. Nobody is signed in yet, so by address. */
export const authLimiter = makeLimiter({ name: 'auth', windowMs: 15 * 60 * 1000, limit: 20 });

/**
 * Confirm: the only route that mutates business data.
 *
 * Limited generously -- a real customer confirms one action, occasionally two.
 * Anything approaching this ceiling is a retry loop or an attack, and either
 * way it should be slowed down rather than served.
 */
export const confirmLimiter = makeLimiter({ name: 'confirm', windowMs: 60 * 1000, limit: 10, keyGenerator: perUser });

/**
 * A customer message costs a call to the AI service, and with a live model a
 * GPU's worth of work. Twenty a minute is far beyond anyone typing, and far
 * below what a script could otherwise make the model do.
 */
export const messageLimiter = makeLimiter({ name: 'message', windowMs: 60 * 1000, limit: 20, keyGenerator: perUser });

/**
 * Deleting an account asks for the password again, which makes the route a
 * place to guess passwords with a stolen session. Five tries in fifteen minutes.
 */
export const accountLimiter = makeLimiter({
  name: 'account',
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: perUser,
});

/**
 * Asking for a person. One active ticket per conversation bounds the tickets,
 * but not the events each request appends to one (Phase 11 §11).
 */
export const escalationLimiter = makeLimiter({
  name: 'escalation',
  windowMs: 10 * 60 * 1000,
  limit: 5,
  keyGenerator: perUser,
});
