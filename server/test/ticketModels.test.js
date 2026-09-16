import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Ticket, TicketEvent, IMMUTABLE_MODELS } from '../src/db/models/index.js';

/**
 * The Phase 11 schema changes. Declarations are asserted; that MongoDB enforces
 * them needs a replica set, and is listed as unverified in the Phase 11 doc.
 */

const oid = () => new mongoose.Types.ObjectId();
const indexOn = (model, fields) =>
  model.schema.indexes().find(([spec]) => JSON.stringify(spec) === JSON.stringify(fields));

test('FR-8.3, ADR 0010: a conversation has at most one active ticket, by partial unique index', () => {
  const index = indexOn(Ticket, { tenantId: 1, conversationId: 1 });
  assert.ok(index, 'no (tenantId, conversationId) index on Ticket');
  assert.equal(index[1].unique, true);
  // Partial: closed tickets are not counted, so a settled case never blocks a
  // new escalation of the same conversation.
  assert.deepEqual(index[1].partialFilterExpression, { active: true });
});

test('the default queue has its own index: active tickets, oldest first', () => {
  assert.ok(indexOn(Ticket, { tenantId: 1, active: 1, openedAt: 1, _id: 1 }));
});

test('Phase 14: both queue indexes end in the queue’s full sort, so no page is sorted in memory', () => {
  // The queue sorts on (openedAt, _id) -- _id breaks ties for the keyset cursor.
  // Indexes ending at openedAt were chosen by the planner and still left a sort
  // in memory over every matching ticket, found by explaining the query against
  // a real server (perf/queryPlans.js).
  for (const filterField of ['active', 'currentStatus']) {
    assert.ok(
      indexOn(Ticket, { tenantId: 1, [filterField]: 1, openedAt: 1, _id: 1 }),
      `no (tenantId, ${filterField}, openedAt, _id) index`,
    );
  }
});

test('a new ticket is open, active, and has counted no events yet', () => {
  const ticket = new Ticket({ tenantId: oid(), conversationId: oid(), customerId: oid() });
  assert.equal(ticket.validateSync(), undefined);
  assert.equal(ticket.currentStatus, 'open');
  assert.equal(ticket.active, true);
  assert.equal(ticket.lastEventSeq, 0);
});

test('an event can name the proposal behind it, and accepts proposal_malformed as its reason', () => {
  const event = new TicketEvent({
    tenantId: oid(),
    ticketId: oid(),
    seq: 1,
    type: 'created',
    actor: { kind: 'system' },
    reason: 'proposal_malformed',
    proposalId: oid(),
  });
  assert.equal(event.validateSync(), undefined);
});

test('TicketEvent.reason is still a closed set: free text cannot reach an immutable row', () => {
  const event = new TicketEvent({
    tenantId: oid(),
    ticketId: oid(),
    seq: 1,
    type: 'escalated',
    actor: { kind: 'user', userId: oid() },
    reason: 'customer said her name is Jane and she is upset',
  });
  assert.ok(event.validateSync()?.errors?.reason);
});

test('TicketEvent is still append-only', () => {
  assert.ok(IMMUTABLE_MODELS.includes('TicketEvent'));
});
