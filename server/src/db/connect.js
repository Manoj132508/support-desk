import mongoose from 'mongoose';
import { config } from '../config/env.js';

/**
 * The Atlas connection.
 *
 * Two things worth knowing before reading further.
 *
 * 1. THE DATABASE MUST BE A REPLICA SET. Execution commits the order update,
 *    the ActionOutcome insert and the TicketEvent insert in ONE multi-document
 *    transaction (Phase 3 section 9), which is what makes "execution succeeded
 *    but the audit write failed" impossible rather than merely unlikely.
 *    Standalone mongod cannot run transactions. Atlas clusters are replica sets
 *    by default, which is why Atlas was chosen; the local fallback needs
 *    `--replSet rs0` and one `rs.initiate()`.
 *
 * 2. `strictQuery` is on. A filter naming a field that is not in the schema
 *    would otherwise be silently dropped -- and a dropped `tenantId` is a
 *    cross-tenant read, so the permissive default is a security setting in
 *    disguise.
 */

mongoose.set('strictQuery', true);

let state = 'unconfigured';

export function databaseState() {
  if (!config.mongodbUri) return 'unconfigured';
  // 1 = connected, 2 = connecting, 0 = disconnected, 3 = disconnecting
  return mongoose.connection.readyState === 1 ? 'ok' : state;
}

export function connectionOptions(value = config) {
  return {
    // Fail fast rather than hanging a request for 30 seconds. A request that
    // cannot reach the database should return a fault promptly so the UI can
    // say so, not sit there looking like a slow response.
    serverSelectionTimeoutMS: 5000,
    // Every write must reach a majority before it is acknowledged. For a
    // system whose central claim is that its audit trail is trustworthy, an
    // acknowledged write that a failover could lose is not acceptable.
    writeConcern: { w: 'majority' },
    // Never in production: a failed automatic build is silent, and some of
    // these indexes are guarantees. Production applies them as a deploy step
    // and refuses to start without them (db/indexes.js). Development keeps the
    // convenience.
    autoIndex: !value.isProduction,
  };
}

export async function connectDatabase() {
  if (!config.mongodbUri) {
    // Not an error. Phases 1-6 run without a database, and the honest report
    // is "you have not configured this" rather than a crash or a fake "ok".
    state = 'unconfigured';
    return null;
  }

  state = 'unreachable';

  mongoose.connection.on('connected', () => {
    state = 'ok';
  });
  mongoose.connection.on('disconnected', () => {
    state = 'unreachable';
  });
  mongoose.connection.on('error', () => {
    state = 'unreachable';
  });

  await mongoose.connect(config.mongodbUri, connectionOptions(config));

  await assertTransactionsAvailable();
  return mongoose.connection;
}

/**
 * Fail at startup, not at the first cancellation.
 *
 * If the deployment is pointed at a standalone mongod, every read works, every
 * insert works, and the ONE operation that matters -- executing an action
 * inside a transaction -- fails. That failure would arrive in production, on
 * the mutating route, which is the worst place to discover a configuration
 * mistake. So we find out now.
 *
 * THE READ INSIDE THE TRANSACTION IS THE CHECK. The first version started a
 * transaction and aborted it with nothing in between, and it never failed: the
 * driver treats a transaction with no operations as client-side state, so
 * nothing reached the server for it to refuse. Pointed at a real standalone
 * mongod on 2026-09-16, that version let the API start, and a transactional
 * write then failed with "Transaction numbers are only allowed on a replica
 * set member or mongos". A read carries the transaction number, so a standalone
 * rejects it here, at startup. It reads a collection that need not exist, and
 * reading creates nothing.
 */
export const TRANSACTION_PROBE_COLLECTION = 'transaction_probe';

export async function assertTransactionsAvailable(connection = mongoose.connection) {
  const session = await connection.startSession();
  try {
    session.startTransaction();
    await connection.db.collection(TRANSACTION_PROBE_COLLECTION).findOne({}, { session });
    await session.abortTransaction();
  } catch (error) {
    throw new Error(
      'This MongoDB deployment does not support transactions, which this ' +
        'application requires: action execution commits the order update, the ' +
        'audit record and the ticket event together or not at all. Use an Atlas ' +
        'cluster, or run mongod with --replSet. Original error: ' +
        error.message,
    );
  } finally {
    // Ending a session aborts any transaction still open on it, including one
    // left open by the read failing.
    await session.endSession();
  }
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  state = 'unconfigured';
}
