import { Router } from 'express';
import { requireRole, STAFF } from '../middleware/requireRole.js';
import { makeTicketService } from '../tickets/ticketService.js';
import { makeMongoTicketRepo } from '../tickets/mongoTicketRepo.js';

/**
 * GET  /api/tickets              agent, lead, admin   the queue (FR-10.1)
 * GET  /api/tickets/:id          agent, lead, admin   one ticket, its events, transcript and attempts
 * POST /api/tickets/:id/status   agent, lead, admin   a transition (FR-9); illegal ⇒ 422
 *
 * Staff only, because a ticket's detail is the internal channel: rule keys,
 * versions and internal reasons (ADR 0007). The actor on every transition is
 * the signed-in user, taken from the session; the tenant is in every query.
 */
export function makeTicketsRouter({ service } = {}) {
  const tickets = service ?? makeTicketService({ repo: makeMongoTicketRepo() });
  const router = Router();
  const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.use(requireRole(STAFF));

  router.get(
    '/',
    handle(async (req, res) => {
      res.json(await tickets.list(req, req.query));
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res) => {
      res.json(await tickets.detail(req, req.params.id));
    }),
  );

  router.post(
    '/:id/status',
    handle(async (req, res) => {
      res.json(
        await tickets.transition(req, {
          ticketId: req.params.id,
          to: req.body?.status,
          user: req.user,
          correlationId: req.correlationId ?? null,
        }),
      );
    }),
  );

  return router;
}
