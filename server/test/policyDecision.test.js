import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { PolicyDecision, ActionProposal } from '../src/db/models/index.js';
import { DECISION_REASONS } from '../src/policy/vocabulary.js';
import { evaluate, toStoredDecision } from '../src/policy/engine.js';

/**
 * PolicyDecision: one immutable row per evaluation.
 *
 * It exists because a pending proposal has to carry its proposal-time decision
 * across two HTTP requests. These tests pin the two things that could quietly
 * lose that record: a decision the engine can produce that the schema refuses to
 * store, and a uniqueness rule that would reject a legitimate retry.
 */

const oid = () => new mongoose.Types.ObjectId();
const NOW = new Date('2026-09-14T12:00:00Z');
const CANCEL = { actionType: 'order.cancel' };
const WORLD = {
  order: { status: 'paid', totalMinor: 4999, currency: 'GBP', placedAt: new Date('2026-09-14T09:00:00Z') },
  customer: { orderCount90d: 1 },
};

function rule(overrides = {}) {
  return {
    _id: oid(),
    ruleKey: 'R',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 100,
    conditions: [],
    outcome: 'confirm-required',
    customerMessage: 'm',
    internalReason: 'r',
    ...overrides,
  };
}

function rowFor(decision, stage = 'proposal') {
  return {
    tenantId: oid(),
    proposalId: oid(),
    stage,
    decision: toStoredDecision(decision),
    defaulted: decision.defaulted,
    reason: decision.reason,
    clampedFrom: decision.clampedFrom,
  };
}

test('EVERY way the engine can fail closed is storable', () => {
  // A reason the engine can produce but the schema rejects would fail to record
  // precisely the decisions most worth reviewing -- the ones the engine could
  // not make. So each one is produced for real and stored.
  const failClosed = [
    evaluate({ rules: [], proposal: CANCEL, world: WORLD, now: NOW }),
    evaluate({
      rules: [rule({ conditions: [{ field: 'customer.orderCount90d', op: 'gt', value: 5 }] })],
      proposal: CANCEL,
      world: { order: WORLD.order },
      now: NOW,
    }),
    evaluate({
      rules: [rule({ conditions: [{ field: 'order.colour', op: 'eq', value: 'red' }] })],
      proposal: CANCEL,
      world: WORLD,
      now: NOW,
    }),
  ];

  const produced = new Set();
  for (const decision of failClosed) {
    assert.equal(decision.defaulted, true);
    assert.equal(new PolicyDecision(rowFor(decision)).validateSync(), undefined, decision.reason);
    produced.add(decision.reason);
  }
  assert.deepEqual([...produced].sort(), [...DECISION_REASONS].sort());
});

test('an ordinary matched decision is storable, with no reason', () => {
  const decision = evaluate({ rules: [rule()], proposal: CANCEL, world: WORLD, now: NOW });
  const record = new PolicyDecision(rowFor(decision));
  assert.equal(record.validateSync(), undefined);
  assert.equal(record.reason, null);
});

test('a clamped auto-execute is storable, so the audit shows the rule asked for it', () => {
  const decision = evaluate({ rules: [rule({ outcome: 'auto-execute' })], proposal: CANCEL, world: WORLD, now: NOW });
  const record = new PolicyDecision(rowFor(decision));
  assert.equal(record.validateSync(), undefined);
  assert.equal(record.clampedFrom, 'auto-execute');
  assert.equal(record.decision.outcome, 'confirm-required');
});

test('a free-text reason cannot be stored', () => {
  const decision = evaluate({ rules: [], proposal: CANCEL, world: WORLD, now: NOW });
  const record = new PolicyDecision({ ...rowFor(decision), reason: 'the model insisted' });
  assert.ok(record.validateSync()?.errors?.reason);
});

test('the stage is one of exactly two values', () => {
  const decision = evaluate({ rules: [rule()], proposal: CANCEL, world: WORLD, now: NOW });
  const record = new PolicyDecision({ ...rowFor(decision), stage: 'afterwards' });
  assert.ok(record.validateSync()?.errors?.stage);
});

test('ONE proposal-stage decision per proposal, but execution-stage retries are allowed', () => {
  const unique = PolicyDecision.schema
    .indexes()
    .filter(([, options]) => options?.unique);

  assert.equal(unique.length, 1, 'exactly one unique index');
  const [fields, options] = unique[0];
  assert.deepEqual(fields, { proposalId: 1, stage: 1 });
  // Partial: it constrains ONLY the proposal stage. A unique index across both
  // stages would reject the second execution-stage evaluation of a confirm
  // that hit a version conflict and was retried -- turning a correct retry
  // into a 500.
  assert.deepEqual(options.partialFilterExpression, { stage: 'proposal' });
});

test('a resolved proposal must carry its server-rendered confirmation text', () => {
  const withoutText = new ActionProposal({
    tenantId: oid(),
    conversationId: oid(),
    customerId: oid(),
    actionType: 'order.cancel',
    target: { kind: 'order', orderId: oid(), orderNumber: '1043' },
  });
  assert.ok(withoutText.validateSync()?.errors?.confirmText);

  const withText = new ActionProposal({
    tenantId: oid(),
    conversationId: oid(),
    customerId: oid(),
    actionType: 'order.cancel',
    target: { kind: 'order', orderId: oid(), orderNumber: '1043' },
    confirmText: 'Cancel order 1043 — Wireless keyboard, £129.00, placed 12 September 2026.',
  });
  assert.equal(withText.validateSync(), undefined);
});

test('a malformed proposal needs no confirmation text, because it was never offered', () => {
  const malformed = new ActionProposal({
    tenantId: oid(),
    conversationId: oid(),
    customerId: oid(),
    validity: 'malformed',
    problemCodes: ['asserted_authorisation'],
  });
  assert.equal(malformed.validateSync(), undefined);
});
