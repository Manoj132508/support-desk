import { Router } from 'express';
import { healthRouter } from './health.js';
import { authRouter } from './auth.js';
import { conversationsRouter } from './conversations.js';
import { makeConversationEscalationRouter } from './conversationEscalation.js';
import { makeProposalsRouter } from './proposals.js';
import { makeTicketsRouter } from './tickets.js';
import { makePoliciesRouter } from './policies.js';
import { makeAuditRouter } from './audit.js';
import { makeAccountRouter } from './account.js';
import { requireCsrfToken } from '../middleware/csrf.js';
import { authenticate } from '../middleware/authenticate.js';

/**
 * Every route in the Phase 6 contract, mounted.
 *
 * Until the phase that built it, each route returned a correctly shaped 501
 * naming that phase rather than being left out: a 404 on an unbuilt route is
 * indistinguishable from a typo in the path, while a 501 is unambiguous, and it
 * made the contract testable from Phase 6 on. Phase 11 built the last of them.
 *
 * THE ORDER OF THE THREE `use` CALLS BELOW IS THE ACCESS-CONTROL DESIGN.
 * Everything declared after them inherits CSRF protection and authentication
 * by position, so a new protected route is protected by DEFAULT. Forgetting is
 * not an available mistake -- a developer would have to deliberately mount
 * above the line to create an unprotected route.
 */

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

/* ── Conversations — FR-1, FR-2, FR-3 (Phases 9–10), FR-8.2 (Phase 11) ────
 * A customer asking for a person is its own small router, mounted first so it
 * can be tested with a fake service. Every other conversation route falls
 * through to the next router. */
apiRouter.use('/conversations', makeConversationEscalationRouter());
apiRouter.use('/conversations', conversationsRouter);

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
apiRouter.use('/proposals', makeProposalsRouter());

/* ── Tickets — FR-8, FR-9, FR-10 (Phase 11) ───────────────────────────────
 * Staff only, enforced inside the router. There is no ticket escalate route:
 * a customer who has not yet escalated has no ticket, and may not read tickets
 * anyway, so asking for a person is keyed by the conversation (above). */
apiRouter.use('/tickets', makeTicketsRouter());

/* ── Account — FR-13.4 (Phase 12) ─────────────────────────────────────────
 * A customer deleting their own account. Below the line, so it is
 * authenticated and CSRF-protected by position. */
apiRouter.use('/account', makeAccountRouter());

/* ── Policy and audit — FR-11, FR-12 (Phase 10) ─────────────────────────
 * Leads may read both; only admins change rules. The roles are enforced inside
 * each router. POST /api/policies is an addition to the Phase 6 contract, which
 * had no way to create a rule. */
apiRouter.use('/policies', makePoliciesRouter());
apiRouter.use('/audit', makeAuditRouter());

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
  ['post', '/api/conversations/abc/escalate'],
  ['post', '/api/proposals/abc/confirm'],
  ['post', '/api/proposals/abc/reject'],
  ['get', '/api/tickets'],
  ['get', '/api/tickets/abc'],
  ['post', '/api/tickets/abc/status'],
  ['post', '/api/account/delete'],
  ['get', '/api/policies'],
  ['post', '/api/policies'],
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
