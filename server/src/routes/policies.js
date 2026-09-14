import { Router } from 'express';
import { requireRole, LEADERSHIP } from '../middleware/requireRole.js';
import { makePolicyAdmin } from '../policy/policyAdmin.js';
import { makeMongoPolicyRepo } from '../policy/mongoPolicyRepo.js';

/**
 * GET  /api/policies       lead, admin   — baseline and tenant rules, split
 * POST /api/policies       admin         — create a tenant rule at version 1
 * PUT  /api/policies/:id   admin         — write the rule's next version
 *
 * Leads may see what the assistant is allowed to do; only admins may change it.
 *
 * POST is an addition to the Phase 6 contract, which specified reading and
 * editing but no way to create a rule -- a gap, since FR-12.1 requires it and
 * ADR 0008's tenant layering cannot be demonstrated without a tenant rule.
 */
export function makePoliciesRouter({ admin } = {}) {
  const policyAdmin = admin ?? makePolicyAdmin({ repo: makeMongoPolicyRepo() });
  const router = Router();
  const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.get(
    '/',
    requireRole(LEADERSHIP),
    handle(async (req, res) => {
      res.json(await policyAdmin.listPolicies(req));
    }),
  );

  router.post(
    '/',
    requireRole('admin'),
    handle(async (req, res) => {
      const rule = await policyAdmin.createPolicy(req, { definition: req.body, userId: req.user.id });
      res.status(201).json({ rule });
    }),
  );

  router.put(
    '/:id',
    requireRole('admin'),
    handle(async (req, res) => {
      const rule = await policyAdmin.updatePolicy(req, {
        ruleId: req.params.id,
        changes: req.body,
        userId: req.user.id,
      });
      res.json({ rule });
    }),
  );

  return router;
}
