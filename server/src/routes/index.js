import { Router } from 'express';
import { healthRouter } from './health.js';
import { AppError } from '../errors/AppError.js';
import { authLimiter, confirmLimiter } from '../middleware/rateLimit.js';

/**
 * Every route in the Phase 6 contract, mounted.
 *
 * Routes a later phase builds return a correctly shaped 501 rather than being
 * left out. Two reasons:
 *
 * 1. The contract is TESTABLE NOW. A test asserts every declared path is
 *    mounted, so the document and the router cannot drift apart silently.
 * 2. A half-built route cannot pass for a finished one. A 404 on an unbuilt
 *    route is indistinguishable from a typo in the path; a 501 naming its
 *    phase is unambiguous.
 */

/** Declares a route that exists in the contract but is built later. */
function pending(phase) {
  return (req, res, next) => next(AppError.notImplemented(phase));
}

export const apiRouter = Router();

apiRouter.use(healthRouter);

/* ── Auth — FR-13 (Phase 8) ──────────────────────────────────────────────
 * Rate-limited because these are the routes an attacker hammers. */
apiRouter.post('/auth/register', authLimiter, pending('Phase 8'));
apiRouter.post('/auth/login', authLimiter, pending('Phase 8'));
apiRouter.post('/auth/logout', pending('Phase 8'));
apiRouter.get('/auth/me', pending('Phase 8'));

/* ── Conversations — FR-1, FR-2, FR-3 (Phases 9-10) ─────────────────── */
apiRouter.post('/conversations', pending('Phase 9'));
apiRouter.get('/conversations/:id', pending('Phase 9'));
apiRouter.post('/conversations/:id/messages', pending('Phase 9'));

/* ── Proposals — FR-6, FR-7 (Phase 10) ──────────────────────────────────
 *
 * `/confirm` is THE ONLY ROUTE IN THE SYSTEM THAT MUTATES BUSINESS DATA.
 * It is rate-limited because a burst here is either a bug or an attack, and
 * because it is the one place where volume has consequences.
 *
 * Note there is no Idempotency-Key header: the key is derived server-side from
 * the proposal id (ADR 0003), because one proposal must execute at most once
 * and a client-supplied key would be attacker-controlled. */
apiRouter.post('/proposals/:id/confirm', confirmLimiter, pending('Phase 10'));
apiRouter.post('/proposals/:id/reject', pending('Phase 10'));

/* ── Tickets — FR-8, FR-9, FR-10 (Phase 11) ─────────────────────────── */
apiRouter.get('/tickets', pending('Phase 11'));
apiRouter.get('/tickets/:id', pending('Phase 11'));
apiRouter.post('/tickets/:id/status', pending('Phase 11'));
apiRouter.post('/tickets/:id/escalate', pending('Phase 11'));

/* ── Policy and audit — FR-11, FR-12 (Phase 10) ─────────────────────── */
apiRouter.get('/policies', pending('Phase 10'));
apiRouter.put('/policies/:id', pending('Phase 10'));
apiRouter.get('/audit', pending('Phase 10'));

/** The contract, as data. The mount test reads this so the document, the
 *  router and the test cannot drift apart in three directions. */
export const CONTRACT_ROUTES = [
  ['get', '/api/health'],
  ['post', '/api/auth/register'],
  ['post', '/api/auth/login'],
  ['post', '/api/auth/logout'],
  ['get', '/api/auth/me'],
  ['post', '/api/conversations'],
  ['get', '/api/conversations/abc'],
  ['post', '/api/conversations/abc/messages'],
  ['post', '/api/proposals/abc/confirm'],
  ['post', '/api/proposals/abc/reject'],
  ['get', '/api/tickets'],
  ['get', '/api/tickets/abc'],
  ['post', '/api/tickets/abc/status'],
  ['post', '/api/tickets/abc/escalate'],
  ['get', '/api/policies'],
  ['put', '/api/policies/abc'],
  ['get', '/api/audit'],
];
