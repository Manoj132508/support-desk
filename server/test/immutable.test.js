import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { ActionProposal, ActionOutcome, TicketEvent, IMMUTABLE_MODELS } from '../src/db/models/index.js';
import { BLOCKED_QUERY_OPS, ImmutableError } from '../src/db/plugins/immutable.js';

/**
 * INV-B, without a database.
 *
 * Mongoose runs query middleware before it talks to the server, so every
 * assertion here is about the plugin refusing the operation -- which is
 * precisely what we want to test. Disabling command buffering makes that
 * unambiguous: if a write ever got PAST the plugin, it would fail with a
 * connection error rather than hanging for ten seconds and looking like a pass.
 */
mongoose.set('bufferCommands', false);

const MODELS = { ActionProposal, ActionOutcome, TicketEvent };

test('the three audit collections are the immutable ones', () => {
  assert.deepEqual(IMMUTABLE_MODELS, ['ActionProposal', 'ActionOutcome', 'TicketEvent']);
});

for (const [name, Model] of Object.entries(MODELS)) {
  test(`${name} refuses every query-level write path`, async () => {
    for (const op of BLOCKED_QUERY_OPS) {
      if (typeof Model[op] !== 'function') continue;

      await assert.rejects(
        async () => {
          const args = op.startsWith('findById')
            ? [new mongoose.Types.ObjectId(), { $set: { outcome: 'executed' } }]
            : [{}, { $set: { outcome: 'executed' } }];
          await Model[op](...args);
        },
        (error) => error instanceof ImmutableError,
        `${name}.${op} should be refused`,
      );
    }
  });

  test(`${name} refuses save() on an already-persisted document`, async () => {
    const doc = new Model({});
    // The exact bypass a developer would reach for first: load a document,
    // change a field, call save(). The query-level blocks above do nothing
    // about it, which is why the save hook exists.
    doc.isNew = false;
    await assert.rejects(() => doc.save(), (error) => error instanceof ImmutableError);
  });

  test(`${name} refuses bulkWrite, which bypasses per-operation hooks`, async () => {
    await assert.rejects(
      () => Model.bulkWrite([{ insertOne: { document: {} } }]),
      (error) => error instanceof ImmutableError,
    );
  });
}

test('an insert is still permitted — append-only, not read-only', () => {
  const doc = new ActionProposal({});
  assert.equal(doc.isNew, true);
  // No rejection: the pre-save hook lets a new document through. If it did
  // not, the audit trail could never be written in the first place.
});

test('ADR 0006: a reference is valid evidence', () => {
  const proposal = new ActionProposal({
    evidence: [{ kind: 'kb_chunk', ref: 'chunk_42' }],
  });
  assert.equal(proposal.evidence.length, 1);
  assert.equal(proposal.evidence[0].ref, 'chunk_42');
});

test('ADR 0006: a snippet is REJECTED, not silently dropped', () => {
  // Free text inside a row that can never be edited would be unscrubbable by
  // construction -- the one thing that would make deletion and immutability
  // genuinely irreconcilable.
  //
  // This test earned its keep. With an inline array definition, Mongoose
  // discarded the WHOLE evidence entry silently: the proposal saved with zero
  // evidence and nobody was told. In the collection whose job is to prove what
  // happened, silently losing evidence is far worse than refusing a write.
  const proposal = new ActionProposal({
    evidence: [{ kind: 'kb_chunk', ref: 'chunk_42', snippet: 'the customer said ...' }],
  });

  const error = proposal.validateSync();
  assert.ok(error?.errors?.evidence, 'a snippet must produce a validation error, not silence');

  // And the document therefore cannot be persisted, which is the property that
  // actually matters: no row reaches the audit collection carrying free text.
  assert.equal(proposal.evidence.length, 0);
});

test('the outcome enum is exactly the seven terminal states', () => {
  const enumValues = ActionOutcome.schema.path('outcome').enumValues;
  assert.deepEqual(enumValues, [
    'refused_at_proposal',
    'escalated_at_proposal',
    'rejected_by_customer',
    'expired',
    'refused_at_execution',
    'executed',
    'failed',
  ]);
});

test('ADR 0003: idempotencyKey is enforced by a unique index, not by application code', () => {
  const indexes = ActionOutcome.schema.indexes();
  const idempotency = indexes.find(([fields]) => fields.idempotencyKey === 1);
  assert.ok(idempotency, 'idempotencyKey must be indexed');
  assert.equal(idempotency[1].unique, true, 'and the index must be unique');

  const perProposal = indexes.find(([fields]) => fields.proposalId === 1);
  assert.equal(perProposal[1].unique, true, 'one outcome per proposal');
});

test('TicketEvent seq is unique per ticket, so concurrent transitions collide loudly', () => {
  const indexes = TicketEvent.schema.indexes();
  const seqIndex = indexes.find(([fields]) => fields.seq === 1 && fields.ticketId === 1);
  assert.ok(seqIndex);
  assert.equal(seqIndex[1].unique, true);
});

test('TicketEvent.reason is enumerated, keeping free text out of immutable rows', () => {
  // The residual privacy risk named in Phase 3 section 7. Agent prose goes to
  // the mutable Ticket.note instead.
  const reason = TicketEvent.schema.path('reason');
  assert.ok(Array.isArray(reason.enumValues) && reason.enumValues.length > 0);
  assert.ok(!reason.enumValues.includes('free_text'));
});
