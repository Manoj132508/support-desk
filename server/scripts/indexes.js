import { connectDatabase, disconnectDatabase } from '../src/db/connect.js';
import { applyIndexes, indexDrift } from '../src/db/indexes.js';

/**
 * npm run indexes               report any difference; exit 1 if there is one
 * npm run indexes -- --apply    create what is missing, drop what is no longer declared
 *
 * The deploy step that production depends on (src/db/indexes.js): the API will
 * not start there while a declared index is missing. In the compose deployment
 * it runs as a one-off service before the API.
 *
 * `--apply` drops indexes the models do not declare. An index someone added by
 * hand for a reason would go too, so any such index belongs in a model.
 */

async function main() {
  await connectDatabase();
  try {
    if (process.argv.includes('--apply')) {
      const changes = await applyIndexes();
      for (const change of changes) {
        console.log(JSON.stringify({ level: 'info', message: 'Indexes changed', ...change }));
      }
      console.log(JSON.stringify({ level: 'info', message: 'Indexes match the models', changedModels: changes.length }));
      return 0;
    }

    const drift = await indexDrift();
    for (const entry of drift) {
      console.log(JSON.stringify({ level: 'warn', message: 'Indexes differ from the models', ...entry }));
    }
    if (drift.length > 0) {
      console.log(JSON.stringify({ level: 'warn', message: 'Run `npm run indexes -- --apply` to reconcile' }));
      return 1;
    }
    console.log(JSON.stringify({ level: 'info', message: 'Indexes match the models' }));
    return 0;
  } finally {
    await disconnectDatabase();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(JSON.stringify({ level: 'error', message: error.message }));
    process.exit(1);
  });
