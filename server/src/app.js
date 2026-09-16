import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config/env.js';
import { correlationId } from './middleware/correlationId.js';
import { errorEnvelope, notFoundHandler } from './middleware/errorEnvelope.js';
import { apiRouter } from './routes/index.js';

/**
 * The app, as a factory that does NOT listen.
 *
 * Separating "build the app" from "bind a port" is what lets tests do
 * `createApp()` and `listen(0)` -- an ephemeral port chosen by the OS. No fixed
 * test port to collide with a running dev server, no cleanup race between
 * suites, and no `supertest` dependency in a process that will own every
 * consequential action in this system.
 *
 * Middleware order below is not arbitrary; each line depends on the one above:
 *
 *   correlationId  first, so even a body-parse failure is traceable
 *   helmet         security headers before anything can respond
 *   json           parse, with a size cap
 *   cookieParser   before routes that read the session (Phase 8)
 *   apiRouter      the contract
 *   notFound       anything that fell through does not exist
 *   errorEnvelope  LAST, so nothing escapes unshaped
 */
export function createApp() {
  const app = express();

  // Behind the Vite dev proxy in development and nginx in the compose
  // deployment, so the client IP the rate limiter keys on comes from
  // X-Forwarded-For. A count of hops rather than `true`: trusting every hop
  // lets a caller spoof the header and walk around the limiter. Configurable
  // since Phase 15, because the right count is a property of the deployment
  // (config/env.js, test/trustProxy.test.js).
  app.set('trust proxy', config.trustProxyHops);
  app.disable('x-powered-by');

  app.use(correlationId);
  app.use(helmet());
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(cookieParser());

  app.use('/api', apiRouter);

  app.use(notFoundHandler);
  app.use(errorEnvelope);

  return app;
}
