import { Router } from 'express';
import { accountLimiter } from '../middleware/rateLimit.js';
import { requireRole } from '../middleware/requireRole.js';
import { clearAuthCookies } from '../auth/cookies.js';
import { verifyPassword } from '../auth/password.js';
import { makeAccountDeletion } from '../account/accountDeletion.js';
import { makeMongoAccountRepo } from '../account/mongoAccountRepo.js';

function jsonLog(event, fields) {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

/**
 * POST /api/account/delete   customer   { password }   → 204, session cleared
 *
 * FR-13.4. Mounted below the authenticate and CSRF line in routes/index.js, so
 * another site cannot delete someone's account using their own cookie. POST
 * rather than DELETE, because a DELETE with a body is dropped by some proxies.
 * Rate limited per user, since it compares a password.
 */
export function makeAccountRouter({ deletion, limiter = accountLimiter } = {}) {
  const service = deletion ?? makeAccountDeletion({ repo: makeMongoAccountRepo(), verifyPassword, log: jsonLog });
  const router = Router();
  const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.post(
    '/delete',
    requireRole('customer'),
    limiter,
    handle(async (req, res) => {
      await service.deleteOwnAccount({ ctx: req, user: req.user, password: req.body?.password });
      // The user no longer exists, so the next request would fail
      // authentication anyway. Clearing the cookies ends the session now.
      clearAuthCookies(res);
      res.status(204).end();
    }),
  );

  return router;
}
