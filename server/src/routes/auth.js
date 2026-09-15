import { Router } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../errors/AppError.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { authenticate } from '../middleware/authenticate.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { signSessionToken } from '../auth/jwt.js';
import { setSessionCookie, setCsrfCookie, clearAuthCookies } from '../auth/cookies.js';
import { buildRegistration, publicUser } from '../auth/registration.js';
import { checkCredentials } from '../auth/login.js';
import { Tenant, User, Customer } from '../db/models/index.js';

export const authRouter = Router();

/** Express 5 forwards rejected promises to the error handler on its own, but
 *  being explicit keeps the intent obvious to a reader. */
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * POST /api/auth/register — self-registration, customers only.
 *
 * Creates two documents: a `User` (authentication) and a `Customer` (the
 * commerce subject). Phase 3 kept them separate precisely so a deletion can
 * remove credentials while audit rows keep pointing at a Customer id that no
 * longer resolves to a person. They are created in one transaction, because a
 * User with a dangling customerId is an account that can sign in and own
 * nothing.
 */
authRouter.post(
  '/register',
  authLimiter,
  handle(async (req, res) => {
    const input = buildRegistration(req.body);

    const tenant = await Tenant.findOne({ slug: input.tenantSlug });
    // Deliberately the same malformed error as a bad email, with no hint that
    // the tenant does not exist. Otherwise registration becomes an oracle for
    // enumerating which organisations use this product.
    if (!tenant) throw AppError.malformed('Registration rejected: unknown tenant');

    const existing = await User.findOne({ tenantId: tenant._id, email: input.email });
    if (existing) {
      // Same shape again. "That email is already registered" tells an attacker
      // which addresses hold accounts.
      throw AppError.malformed('Registration rejected: unable to register with those details');
    }

    const passwordHash = await hashPassword(input.password);

    const session = await mongoose.startSession();
    let user;
    try {
      await session.withTransaction(async () => {
        const [customer] = await Customer.create(
          [{ tenantId: tenant._id, displayName: input.name, email: input.email }],
          { session },
        );
        [user] = await User.create(
          [
            {
              tenantId: tenant._id,
              email: input.email,
              passwordHash,
              name: input.name,
              role: input.role,
              customerId: customer._id,
            },
          ],
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    issueSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  }),
);

/**
 * POST /api/auth/login   { tenantSlug, email, password }
 *
 * The user is found within the named organisation (Phase 12; see
 * auth/login.js). The password hash is `select: false` on the schema, so it
 * must be asked for explicitly. That default is what stops every other query in
 * the system from carrying a hash it does not need.
 */
authRouter.post(
  '/login',
  authLimiter,
  handle(async (req, res) => {
    const user = await checkCredentials(req.body, {
      findTenantBySlug: (slug) => Tenant.findOne({ slug }),
      findUserForLogin: (tenantId, email) => User.findOne({ tenantId, email }).select('+passwordHash'),
      verifyPassword,
    });

    if (!user) {
      throw new AppError('fault', {
        message: 'Invalid email or password',
        status: 401,
        expected: true,
      });
    }

    issueSession(res, user);
    res.json({ user: publicUser(user) });
  }),
);

/**
 * POST /api/auth/logout
 *
 * Unauthenticated on purpose. Someone holding an expired or malformed cookie
 * still needs a way to clear it, and refusing to sign out a session we do not
 * recognise leaves the user stuck with a cookie they cannot get rid of.
 */
authRouter.post('/logout', (req, res) => {
  clearAuthCookies(res);
  res.status(204).end();
});

/** GET /api/auth/me — the question the client's AuthProvider asks on boot. */
authRouter.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

function issueSession(res, user) {
  setSessionCookie(res, signSessionToken(user._id));
  setCsrfCookie(res);
}
