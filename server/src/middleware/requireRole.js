import { AppError } from '../errors/AppError.js';

/**
 * Role gate. Runs after `authenticate`, never instead of it.
 *
 * The status is 403, and the kind is `fault` rather than `refused`. Worth being
 * precise about, because this project uses "refused" for one specific thing: a
 * POLICY RULE declined an action. That renders in the policy language and
 * belongs in the audit that demonstrates INV-A.
 *
 * "You are an agent and this screen is for leads" is not a policy decision
 * about an action. Filing it as `refused` would put access-control events into
 * the record that exists to show what the assistant tried to do and was stopped
 * from doing -- diluting exactly the evidence the project rests on.
 */
export function requireRole(...roles) {
  const allowed = new Set(roles.flat());

  return function roleGate(req, res, next) {
    if (!req.user) {
      return next(
        new AppError('fault', { message: 'Authentication required', status: 401, expected: true }),
      );
    }
    if (!allowed.has(req.user.role)) {
      return next(
        new AppError('fault', { message: 'Insufficient role', status: 403, expected: true }),
      );
    }
    return next();
  };
}

/** Convenience sets, named after the actor table in Phase 1 section 2. */
export const STAFF = ['agent', 'lead', 'admin'];
export const LEADERSHIP = ['lead', 'admin'];
