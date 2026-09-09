import { Router } from 'express';
import { config } from '../config/env.js';

export const healthRouter = Router();

/**
 * FR-14.1: report each dependency INDEPENDENTLY.
 *
 * The interesting decision is that this returns 200 even when degraded.
 *
 * With the AI service down, the desk still serves tickets, conversation
 * history, the agent console and the audit log (FR-14.3) -- only new assistant
 * turns are unavailable. Returning 503 would take a load balancer's healthy
 * instance out of rotation and turn a partial outage into a total one. The
 * body says exactly what is wrong; the status says whether this instance can
 * serve traffic, and it can.
 *
 * `unconfigured` is distinct from `unreachable` on purpose. "You have not set
 * MONGODB_URI" and "the database is refusing connections" are different
 * problems with different fixes, and collapsing them wastes the first ten
 * minutes of every incident.
 */
healthRouter.get('/health', (req, res) => {
  // Phase 7 replaces these with real probes. Until then the honest answer is
  // that nothing has been checked, and reporting "ok" would be a lie that only
  // gets discovered during an incident.
  const database = config.mongodbUri ? 'unreachable' : 'unconfigured';
  const aiService = config.aiServiceUrl ? 'unreachable' : 'unconfigured';

  const checks = { api: 'ok', database, aiService };
  const status = Object.values(checks).every((value) => value === 'ok') ? 'ok' : 'degraded';

  res.json({ status, ...checks, correlationId: req.correlationId });
});
