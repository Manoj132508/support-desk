import { createApp } from './app.js';
import { config, productionConfigProblems } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './db/connect.js';
import { indexDrift, missingIndexProblems } from './db/indexes.js';
import { makeShutdown } from './shutdown.js';

/**
 * Refuse to start an unsafe production deployment (Phase 12). The problems name
 * variables and never their values, so the log line itself leaks nothing.
 */
if (config.isProduction) {
  const problems = productionConfigProblems(config);
  if (problems.length > 0) {
    console.error(
      JSON.stringify({ level: 'error', message: 'Refusing to start: unsafe production configuration', problems }),
    );
    process.exit(1);
  }
}

/**
 * Connect BEFORE listening.
 *
 * The transaction check in connectDatabase throws if the deployment is a
 * standalone mongod. Failing at startup means a misconfiguration is found by
 * whoever deployed it, rather than by a customer whose cancellation fails on
 * the one route that mutates business data.
 *
 * A missing MONGODB_URI is not fatal in development: Phases 1-6 ran without a
 * database, and /api/health reports it honestly as `unconfigured`. In
 * production the check above has already refused it.
 */
try {
  await connectDatabase();
} catch (error) {
  console.error(
    JSON.stringify({ level: 'error', message: 'Database startup failed', error: error.message }),
  );
  process.exit(1);
}

/**
 * In production, the declared indexes must already exist (Phase 15). Some are
 * guarantees -- the unique idempotency key is what stops a confirmation
 * executing twice -- and production does not build them automatically, because
 * a failed automatic build is silent (db/indexes.js). Extra indexes only warn.
 */
if (config.isProduction) {
  const drift = await indexDrift();
  const missing = missingIndexProblems(drift);
  if (missing.length > 0) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: 'Refusing to start: declared indexes are missing. Run `npm run indexes -- --apply` first.',
        problems: missing,
      }),
    );
    process.exit(1);
  }
  for (const entry of drift.filter((item) => item.extra.length > 0)) {
    console.warn(JSON.stringify({ level: 'warn', message: 'Indexes the models no longer declare', ...entry }));
  }
}

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      message: 'API listening',
      port: config.port,
      env: config.nodeEnv,
      database: config.mongodbUri ? 'configured' : 'unconfigured',
    }),
  );
});

// SIGTERM from `docker stop` or an orchestrator; SIGINT from Ctrl+C and from
// `node --watch` restarting in development (Phase 15, shutdown.js).
const shutdown = makeShutdown({ server, disconnect: disconnectDatabase, exit: (code) => process.exit(code) });
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
