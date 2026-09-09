import { AppError } from '../errors/AppError.js';
import { verifySessionToken } from '../auth/jwt.js';
import { SESSION_COOKIE } from '../auth/cookies.js';
import { User } from '../db/models/index.js';

/**
 * THIS IS THE SECURITY BOUNDARY.
 *
 * The client's <ProtectedRoute> decides what to render; it protects navigation,
 * not data. Anyone can call this API directly with curl, so every protected
 * route passes through here and the server's answer is the only one that
 * counts.
 *
 * The user loader is injectable. Not for ceremony -- it is what lets the whole
 * of this middleware be tested without a database, which is the same reasoning
 * that made the policy engine pure (NFR-6). The thing that decides who you are
 * should be exhaustively testable.
 */

async function loadUserById(id) {
  return User.findById(id);
}

export function makeAuthenticate({ loadUser = loadUserById } = {}) {
  return async function authenticate(req, res, next) {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (!token) throw unauthorised();

      const payload = verifySessionToken(token);
      if (!payload?.sub) throw unauthorised();

      /*
       * The database lookup is not redundant. A signature proves the token was
       * minted by us and has not expired; it says nothing about whether the
       * account still exists, is still enabled, or still holds the role it had
       * when the token was issued.
       *
       * In this system that is not a nicety. `role` decides who may authorise a
       * consequential action, so a stale role is a stale authorisation --
       * demoting an admin has to take effect now, not whenever their token
       * happens to expire. The cost is one indexed find per request, taken
       * deliberately.
       */
      const user = await loadUser(payload.sub);
      if (!user || user.status !== 'active') throw unauthorised();

      /*
       * A plain object, not the Mongoose document, so no handler can
       * accidentally serialise a model or call .save() on it.
       *
       * `tenantId` is set HERE, from the loaded user, and nowhere else. It is
       * never read from a body, a query string or a header. That is what makes
       * ADR 0005's promise real: the tenant a request operates in is derived
       * from the session, so a caller cannot choose it.
       */
      req.user = {
        id: String(user._id),
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: String(user.tenantId),
        customerId: user.customerId ? String(user.customerId) : null,
      };
      req.tenantId = req.user.tenantId;

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * One 401 for every failure: no cookie, bad signature, expired, unknown user,
 * disabled account. The client cannot tell them apart, and neither can an
 * attacker -- "expired" versus "no such user" is an account-enumeration hint.
 */
function unauthorised() {
  return new AppError('fault', { message: 'Authentication required', status: 401, expected: true });
}

export const authenticate = makeAuthenticate();
