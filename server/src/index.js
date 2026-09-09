import { createApp } from './app.js';
import { config } from './config/env.js';
import { connectDatabase } from './db/connect.js';

/**
 * Connect BEFORE listening.
 *
 * The transaction check in connectDatabase throws if the deployment is a
 * standalone mongod. Failing at startup means a misconfiguration is found by
 * whoever deployed it, rather than by a customer whose cancellation fails on
 * the one route that mutates business data.
 *
 * A missing MONGODB_URI is not fatal: Phases 1-6 run without a database, and
 * /api/health reports it honestly as `unconfigured`.
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
