import { Router } from 'express';
import { databaseState } from '../db/connect.js';
import { probeAiService } from '../services/aiClient.js';

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
healthRouter.get('/health', async (req, res) => {
  // Both probes are real: the database reports its live connection state
  // (Phase 7), and the AI service is asked (Phase 14 -- see probeAiService).
  const database = databaseState();
  const aiService = await probeAiService();

  const checks = { api: 'ok', database, aiService };
  const status = Object.values(checks).every((value) => value === 'ok') ? 'ok' : 'degraded';

  res.json({ status, ...checks, correlationId: req.correlationId });
});
