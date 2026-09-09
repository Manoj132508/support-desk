import { Router } from 'express';
import { healthRouter } from './health.js';
import { authRouter } from './auth.js';
import { AppError } from '../errors/AppError.js';
import { confirmLimiter } from '../middleware/rateLimit.js';
import { requireCsrfToken } from '../middleware/csrf.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole, STAFF, LEADERSHIP } from '../middleware/requireRole.js';

/**
 * Every route in the Phase 6 contract, mounted.
 *
 * Routes a later phase builds return a correctly shaped 501 rather than being
 * left out: a 404 on an unbuilt route is indistinguishable from a typo in the
 * path, while a 501 naming its phase is unambiguous, and it makes the contract
 * testable now.
 *
 * THE ORDER OF THE THREE `use` CALLS BELOW IS THE ACCESS-CONTROL DESIGN.
 * Everything declared after them inherits CSRF protection and authentication
 * by position, so a new protected route is protected by DEFAULT. Forgetting is
 * not an available mistake -- a developer would have to deliberately mount
 * above the line to create an unprotected route.
 */

function pending(phase) {
  return (req, res, next) => next(AppError.notImplemented(phase));
}

export const apiRouter = Router();

/* ── Public ───────────────────────────────────────────────────────────────
 * Health is unauthenticated so a load balancer can reach it. */
apiRouter.use(healthRouter);

/*
 * Auth is mounted ABOVE the CSRF gate, because register and login cannot carry
 * a CSRF token -- the cookie that would supply it is set BY those requests. The
 * exposure is "login CSRF", where an attacker signs a victim into the
 * attacker's account; SameSite=Strict on the session cookie is the defence
 * there, and it is a materially smaller problem than being unable to log in.
 *
 * Logout is exempt too, deliberately: someone holding a stale or malformed
 * cookie still needs a way to clear it, and a CSRF-forced logout is an
 * annoyance rather than a compromise.
 */
apiRouter.use('/auth', authRouter);

/* ── The line. Everything below is protected. ─────────────────────────────
 *
 * `authenticate` runs BEFORE `requireCsrfToken`, and the order was chosen, not
 * inherited. CSRF exists to prove a request from an authenticated browser was
 * genuine, so it is only meaningful once there IS a session -- and putting it
 * first answers a signed-out user's request with 403 ("forbidden") when the
 * true answer is 401 ("sign in"). Misleading a legitimate client to save a
 * database lookup on forged requests is the wrong trade.
 */
apiRouter.use(authenticate);
apiRouter.use(requireCsrfToken);

/* ── Conversations — FR-1, FR-2, FR-3 (Phases 9-10) ─────────────────────── */
apiRouter.post('/conversations', pending('Phase 9'));
apiRouter.get('/conversations/:id', pending('Phase 9'));
apiRouter.post('/conversations/:id/messages', pending('Phase 9'));

/* ── Proposals — FR-6, FR-7 (Phase 10) ──────────────────────────────────
 *
 * `/confirm` is THE ONLY ROUTE IN THE SYSTEM THAT MUTATES BUSINESS DATA. It is
 * rate-limited because a burst there is either a bug or an attack, and it is
 * the route the CSRF gate above matters most for: without it, another site
 * could cause a real cancellation using a customer's own session.
 *
 * There is no Idempotency-Key header -- the key is derived server-side from the
 * proposal id (ADR 0003), because one proposal must execute at most once and a
 * client-supplied key would be attacker-controlled. */
apiRouter.post('/proposals/:id/confirm', confirmLimiter, pending('Phase 10'));
apiRouter.post('/proposals/:id/reject', pending('Phase 10'));

/* ── Tickets — FR-8, FR-9, FR-10 (Phase 11) ─────────────────────────────── */
apiRouter.get('/tickets', requireRole(STAFF), pending('Phase 11'));
apiRouter.get('/tickets/:id', requireRole(STAFF), pending('Phase 11'));
apiRouter.post('/tickets/:id/status', requireRole(STAFF), pending('Phase 11'));
apiRouter.post('/tickets/:id/escalate', pending('Phase 11'));

/* ── Policy and audit — FR-11, FR-12 (Phase 10) ─────────────────────────
 * Leads and admins only. These are the screens that decide what the assistant
 * may do and show what it tried to do. */
apiRouter.get('/policies', requireRole(LEADERSHIP), pending('Phase 10'));
apiRouter.put('/policies/:id', requireRole('admin'), pending('Phase 10'));
apiRouter.get('/audit', requireRole(LEADERSHIP), pending('Phase 10'));

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

/** Routes reachable without a session. Everything else must answer 401.
 *  Exported so a test can assert the list rather than a reviewer eyeballing
 *  middleware order. */
export const PUBLIC_ROUTES = [
  ['get', '/api/health'],
  ['post', '/api/auth/register'],
  ['post', '/api/auth/login'],
  ['post', '/api/auth/logout'],
];
