import { Router } from 'express';
import { AppError } from '../errors/AppError.js';
import { requireRole } from '../middleware/requireRole.js';
import { makeTicketService } from '../tickets/ticketService.js';
import { makeMongoTicketRepo } from '../tickets/mongoTicketRepo.js';

/**
 * POST /api/conversations/:id/escalate   customer
 *
 * A customer asking for a person (FR-8.2, ADR 0010). Keyed by the conversation,
 * not by a ticket: a customer who has not yet escalated has no ticket, and may
 * not read tickets anyway. This replaces the Phase 6 contract's
 * `POST /api/tickets/:id/escalate`, which could not have served them.
 *
 * Every identifier comes from the session except the conversation in the path,
 * which the service looks up within this customer's own conversations. An
 * optional `proposalId` in the body is a claim that the customer is asking from
 * a refusal; the service believes it only if it can see that refusal.
 *
 * Its own router, mounted ahead of the other conversation routes, so it can be
 * tested with a fake service.
 */
export function makeConversationEscalationRouter({ service } = {}) {
  const tickets = service ?? makeTicketService({ repo: makeMongoTicketRepo() });
  const router = Router();
  const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.post(
    '/:id/escalate',
    requireRole('customer'),
    handle(async (req, res) => {
      // A customer login with no linked profile has no conversations to
      // escalate. "Not found" is true, and describes nothing about the account.
      if (!req.user.customerId) throw AppError.notFound();

      const proposalId = typeof req.body?.proposalId === 'string' ? req.body.proposalId : null;
      res.json(
        await tickets.escalateForCustomer(req, {
          customerId: req.user.customerId,
          conversationId: req.params.id,
          proposalId,
          userId: req.user.id,
          correlationId: req.correlationId ?? null,
        }),
      );
    }),
  );

  return router;
}
