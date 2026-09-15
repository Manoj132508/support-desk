import test from 'node:test';
import assert from 'node:assert/strict';
import { planTransition, statusFromEvents } from '../src/domain/ticketState.js';

/**
 * A manual transition, planned. FR-9: an illegal move is refused by the server,
 * and every legal one is recorded with who made it.
 */

const AGENT = { kind: 'user', userId: 'agent-1' };
const NOW = new Date('2026-09-15T12:00:00Z');

test('taking an open ticket assigns it to whoever took it', () => {
  const plan = planTransition({ ticket: { currentStatus: 'open' }, to: 'assigned', actor: AGENT, now: NOW });
  assert.deepEqual(plan, {
    expectedStatus: 'open',
    set: { currentStatus: 'assigned', assigneeId: 'agent-1' },
    event: {
      type: 'assigned',
      fromStatus: 'open',
      toStatus: 'assigned',
      actor: { kind: 'user', userId: 'agent-1' },
      reason: 'agent_action',
    },
  });
});

test('resolving is a status change that leaves the assignee alone', () => {
  const plan = planTransition({ ticket: { currentStatus: 'assigned' }, to: 'resolved', actor: AGENT, now: NOW });
  assert.deepEqual(plan.set, { currentStatus: 'resolved' });
  assert.equal(plan.event.type, 'status_changed');
});

test('closing retires the ticket, so a later escalation opens a new one', () => {
  const plan = planTransition({ ticket: { currentStatus: 'resolved' }, to: 'closed', actor: AGENT, now: NOW });
  assert.deepEqual(plan.set, { currentStatus: 'closed', active: false, closedAt: NOW });
});

test('FR-9.2: an illegal move is refused as malformed before anything is planned', () => {
  assert.throws(
    () => planTransition({ ticket: { currentStatus: 'open' }, to: 'closed', actor: AGENT, now: NOW }),
    (error) => error.kind === 'malformed' && error.status === 422,
  );
});

test('a manual move needs a user: a missing actor is a programming error, not a bad request', () => {
  for (const actor of [undefined, { kind: 'system' }, { kind: 'user' }]) {
    assert.throws(
      () => planTransition({ ticket: { currentStatus: 'open' }, to: 'assigned', actor, now: NOW }),
      TypeError,
      JSON.stringify(actor),
    );
  }
});

test('ADR 0006: the planned events rebuild the status the plans set', () => {
  let status = 'open';
  const events = [{ seq: 1, type: 'created' }];
  for (const to of ['assigned', 'waiting', 'assigned', 'resolved', 'closed']) {
    const plan = planTransition({ ticket: { currentStatus: status }, to, actor: AGENT, now: NOW });
    events.push({ ...plan.event, seq: events.length + 1 });
    status = plan.set.currentStatus;
  }
  assert.equal(statusFromEvents(events), status);
  assert.equal(status, 'closed');
});
