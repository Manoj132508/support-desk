import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTransactionsAvailable, TRANSACTION_PROBE_COLLECTION } from '../src/db/connect.js';

/**
 * The startup check that the database can run transactions.
 *
 * The fake behaves like the driver on the point that matters: starting and
 * aborting a transaction touch no server, so only an operation run inside the
 * transaction can discover that the server refuses transactions. The check's
 * first version had no such operation, passed against a real standalone mongod,
 * and let the API start on a database where no cancellation could commit.
 */

const STANDALONE_ERROR = 'Transaction numbers are only allowed on a replica set member or mongos';

function fakeConnection({ supportsTransactions }) {
  const calls = { reads: [], ended: false };
  const session = {
    inTransaction: false,
    startTransaction() {
      this.inTransaction = true;
    },
    async abortTransaction() {
      this.inTransaction = false;
    },
    async endSession() {
      calls.ended = true;
    },
  };
  const connection = {
    async startSession() {
      return session;
    },
    db: {
      collection(name) {
        return {
          async findOne(filter, options) {
            calls.reads.push({ name, inTransaction: options?.session?.inTransaction === true });
            if (options?.session?.inTransaction && !supportsTransactions) throw new Error(STANDALONE_ERROR);
            return null;
          },
        };
      },
    },
  };
  return { connection, calls };
}

test('a standalone server is refused at startup, naming what the application needs', async () => {
  const { connection, calls } = fakeConnection({ supportsTransactions: false });

  await assert.rejects(assertTransactionsAvailable(connection), (error) => {
    assert.match(error.message, /does not support transactions/);
    assert.match(error.message, /--replSet/);
    assert.ok(error.message.includes(STANDALONE_ERROR), 'the driver error is kept for whoever reads the log');
    return true;
  });
  assert.equal(calls.ended, true, 'the session is ended even when the check fails');
});

test('the check runs an operation INSIDE the transaction, which is the only thing a server can refuse', async () => {
  const { connection, calls } = fakeConnection({ supportsTransactions: true });

  await assertTransactionsAvailable(connection);

  assert.deepEqual(calls.reads, [{ name: TRANSACTION_PROBE_COLLECTION, inTransaction: true }]);
  assert.equal(calls.ended, true);
});
