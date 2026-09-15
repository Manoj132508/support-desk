import { createApp } from './app.js';
import { config, productionConfigProblems } from './config/env.js';
import { connectDatabase } from './db/connect.js';

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

const app = createApp();

app.listen(config.port, () => {
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
