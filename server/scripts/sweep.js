import { connectDatabase, disconnectDatabase } from '../src/db/connect.js';
import { config } from '../src/config/env.js';
import { makeExpirySweep } from '../src/policy/expirySweep.js';
import { makeMongoSweepRepo } from '../src/policy/mongoSweepRepo.js';

/**
 * npm run sweep — expire proposals nobody decided (ADR 0009 property 5).
 *
 * Run on a schedule by the host (cron, a platform scheduler), NOT on a timer
 * inside the API process. With several API instances, an in-process timer runs
 * once per instance; an external schedule runs it once. And if it ever does run
 * twice at the same moment, nothing breaks: every outcome goes through the
 * idempotency key's unique index, so a proposal can be expired exactly once.
 *
 * Unlike the seed script this is a legitimate production job, so it has no
 * production guard.
 *
 * UNVERIFIED without a database: the sweep logic is tested against the fake
 * repository; this wrapper and the MongoDB repository's pipeline need a real
 * replica set.
 */

function jsonLog(event, fields) {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

async function main() {
  if (!config.mongodbUri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to server/.env and set it.');
  }

  await connectDatabase();
  try {
    const report = await makeExpirySweep({ repo: makeMongoSweepRepo(), log: jsonLog }).sweep();
    console.log(JSON.stringify({ level: 'info', message: 'Expiry sweep finished', ...report }));
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: error.message }));
  process.exit(1);
});
