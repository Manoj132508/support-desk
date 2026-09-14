import { Router } from 'express';
import { AppError } from '../errors/AppError.js';
import { confirmLimiter } from '../middleware/rateLimit.js';
import { requireRole } from '../middleware/requireRole.js';
import { makeActionService } from '../policy/actionService.js';
import { makeMongoActionRepo } from '../policy/mongoActionRepo.js';

/**
 * POST /api/proposals/:id/confirm  — THE ONLY ROUTE THAT MUTATES BUSINESS DATA.
 * POST /api/proposals/:id/reject
 *
 * Mounted below the `authenticate` and `requireCsrfToken` line in
 * routes/index.js, so both are inherited by position. Without the CSRF gate,
 * another site could cause a real cancellation using a customer's own session
 * -- which would be exactly the "action nobody authorised" INV-A exists to
 * prevent, arriving through the browser instead of the model.
 *
 * Everything that decides whether an action may happen lives in the action
 * service. This file does three things only: it establishes WHO is asking, it
 * takes every identifier from the session rather than the request, and it
 * decides what the caller is allowed to be TOLD.
 */

function jsonLog(event, fields) {
  // Structured logs, which rotate. This is where the readable messages go that
  // must never enter an immutable audit row, because they echo model-supplied
  // text.
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

/**
 * What a customer is told about an outcome -- and, as importantly, what not.
 *
 * The outcome row carries both policy decisions: rule keys, versions, matched
 * conditions. That is internal detail (ADR 0007), and returning the row as-is
 * would hand every customer a map of the policy boundary on every
 * confirmation. So the response is built field by field from an allowlist,
 * rather than by deleting the fields someone remembered to delete.
 *
 * The idempotency key is excluded for a related reason: it is an internal
 * identifier with no use to the client, and the client must never be in a
 * position to supply or echo one.
 */
export function publicOutcome(outcome) {
  return {
    proposalId: String(outcome.proposalId),
    outcome: outcome.outcome,
    at: outcome.confirmation?.at ?? null,
    cancellationRef: outcome.result?.cancellationRef ?? null,
  };
}

export function makeProposalsRouter({ service } = {}) {
  const actions = service ?? makeActionService({ repo: makeMongoActionRepo(), log: jsonLog });
  const router = Router();
  const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  /*
   * Customers only. ADR 0009: the CUSTOMER confirms the exact, resolved action
   * shown to them. An agent acting on an escalated case is a different path
   * with a different authorisation (Phase 11) -- not this route used on
   * someone's behalf.
   */
  router.use(requireRole('customer'));

  /** Identifiers come from the session. Never from the body, the query string
   *  or a header -- a request cannot choose whose proposal it confirms. */
  function subject(req) {
    if (!req.user.customerId) {
      // A customer login with no linked profile owns no proposals. Answered as
      // "not found", which is true, rather than as an error that describes the
      // account.
      throw AppError.notFound();
    }
    return {
      ctx: req,
      customerId: req.user.customerId,
      proposalId: req.params.id,
      userId: req.user.id,
    };
  }

  router.post(
    '/:id/confirm',
    confirmLimiter,
    handle(async (req, res) => {
      const result = await actions.confirm(subject(req));
      // 200 only when the action executed (Phase 6 §2.1). A refusal at
      // execution arrives here as a thrown `stale`, and the error envelope
      // turns it into a 409 with the rule's customer text and no rule detail.
      res.json({ outcome: publicOutcome(result.outcome), duplicate: result.duplicate });
    }),
  );

  router.post(
    '/:id/reject',
    handle(async (req, res) => {
      const result = await actions.reject(subject(req));
      res.json({ outcome: publicOutcome(result.outcome), duplicate: result.duplicate });
    }),
  );

  return router;
}
