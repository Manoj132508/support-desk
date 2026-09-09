import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TICKET_STATUS,
  LEGAL_TRANSITIONS,
  canTransition,
  assertTransition,
  statusFromEvents,
} from '../src/domain/ticketState.js';

test('FR-9.2: open → closed is illegal', () => {
  // The example the Phase 6 contract names. Skipping the whole lifecycle would
  // leave a ticket that was never worked looking indistinguishable from one
  // that was.
  assert.equal(canTransition(TICKET_STATUS.OPEN, TICKET_STATUS.CLOSED), false);
  assert.throws(
    () => assertTransition(TICKET_STATUS.OPEN, TICKET_STATUS.CLOSED),
    /Illegal ticket transition/,
  );
});

test('an illegal transition is malformed (422), not refused (403)', () => {
  // No policy rule declined it -- the request was not a valid move. Classifying
  // it as `refused` would put state-machine bugs into the policy audit, which
  // exists to demonstrate INV-A.
  try {
    assertTransition(TICKET_STATUS.OPEN, TICKET_STATUS.CLOSED);
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.kind, 'malformed');
    assert.equal(error.status, 422);
  }
});

test('the happy path is legal end to end', () => {
  const path = ['open', 'assigned', 'waiting', 'assigned', 'resolved', 'closed'];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} → ${path[i + 1]} should be legal`);
  }
});

test('a resolved ticket can be reopened', () => {
  // A customer replying to a resolved ticket should not need a new one, which
  // would scatter one problem across two histories.
  assert.ok(canTransition(TICKET_STATUS.RESOLVED, TICKET_STATUS.ASSIGNED));
});

test('closed is terminal', () => {
  assert.deepEqual(LEGAL_TRANSITIONS[TICKET_STATUS.CLOSED], []);
  for (const status of Object.values(TICKET_STATUS)) {
    assert.equal(canTransition(TICKET_STATUS.CLOSED, status), false);
  }
});

test('an unknown status is rejected before the transition is considered', () => {
  assert.throws(() => assertTransition('open', 'archived'), /Unknown ticket status/);
});

test('ADR 0006: currentStatus can be rebuilt from the event stream', () => {
  // Ticket.currentStatus is a denormalised cache so the queue is one indexed
  // query. This is what makes "the events are the source of truth" checkable
  // rather than aspirational.
  const events = [
    { seq: 1, type: 'created' },
    { seq: 2, type: 'status_changed', fromStatus: 'open', toStatus: 'assigned' },
    { seq: 3, type: 'status_changed', fromStatus: 'assigned', toStatus: 'resolved' },
  ];
  assert.equal(statusFromEvents(events), 'resolved');
});

test('the rebuild uses seq, not arrival order', () => {
  // Two events in the same millisecond are unordered by createdAt, which is
  // exactly why seq exists.
  const shuffled = [
    { seq: 3, type: 'status_changed', toStatus: 'resolved' },
    { seq: 1, type: 'created' },
    { seq: 2, type: 'status_changed', toStatus: 'assigned' },
  ];
  assert.equal(statusFromEvents(shuffled), 'resolved');
});
