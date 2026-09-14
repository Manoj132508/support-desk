import { Router } from 'express';
import { requireRole, LEADERSHIP } from '../middleware/requireRole.js';
import { makeAuditQuery } from '../policy/auditQuery.js';
import { makeMongoAuditRepo } from '../policy/mongoAuditRepo.js';

/**
 * GET /api/audit   lead, admin
 *
 * The internal channel: entries include rule keys, versions and matched
 * conditions, because explaining a decision is the audit's purpose. That is
 * why it is restricted to leadership rather than open to every agent.
 *
 * Query parameters are validated strictly by the audit query itself -- an
 * unrecognised filter is a 422, never silently ignored.
 */
export function makeAuditRouter({ audit } = {}) {
  const auditQuery = audit ?? makeAuditQuery({ repo: makeMongoAuditRepo() });
  const router = Router();
  const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.get(
    '/',
    requireRole(LEADERSHIP),
    handle(async (req, res) => {
      res.json(await auditQuery.list(req, req.query));
    }),
  );

  return router;
}
