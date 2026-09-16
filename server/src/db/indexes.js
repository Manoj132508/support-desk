import mongoose from 'mongoose';
import './models/index.js';

/**
 * Whether the database's indexes match the models' declarations. Phase 15.
 *
 * Some indexes are guarantees, not speed-ups. The unique index on
 * `ActionOutcome.idempotencyKey` is what makes a confirmation execute at most
 * once (ADR 0003); the partial unique index on `Ticket` is what keeps a
 * conversation to one active ticket (ADR 0010). Mongoose builds indexes
 * automatically at startup, and when a build fails -- a unique index over rows
 * that already break it -- it emits an event nothing listens to, and the API
 * runs without the guarantee.
 *
 * So in production indexes are an explicit deploy step (`npm run indexes --
 * --apply`), and the API refuses to start while one is missing. An index the
 * models no longer declare is reported but never fatal: an extra index costs
 * writes, and breaks nothing.
 */

const allModels = () => mongoose.modelNames().map((name) => mongoose.model(name));

const describe = (spec) =>
  Object.entries(spec)
    .map(([field, direction]) => `${field}:${direction}`)
    .join(', ');

/** Every model whose indexes differ from its declarations. */
export async function indexDrift({ models = allModels() } = {}) {
  const drift = [];
  for (const Model of models) {
    const { toCreate, toDrop } = await Model.diffIndexes();
    if (toCreate.length > 0 || toDrop.length > 0) {
      drift.push({ model: Model.modelName, missing: toCreate.map(describe), extra: [...toDrop] });
    }
  }
  return drift;
}

/** What stops the API starting: declared indexes the database does not have. */
export function missingIndexProblems(drift) {
  return drift
    .filter((entry) => entry.missing.length > 0)
    .map((entry) => `${entry.model} is missing ${entry.missing.length} index(es): ${entry.missing.join(' | ')}`);
}

/** Creates what is missing and drops what is no longer declared. Returns what changed. */
export async function applyIndexes({ models = allModels() } = {}) {
  const changes = [];
  for (const Model of models) {
    const { toCreate } = await Model.diffIndexes();
    const dropped = await Model.syncIndexes();
    if (toCreate.length > 0 || dropped.length > 0) {
      changes.push({ model: Model.modelName, created: toCreate.map(describe), dropped });
    }
  }
  return changes;
}
