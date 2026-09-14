import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { ActionProposal } from '../src/db/models/index.js';
import { PROBLEM_CODES } from '../src/policy/vocabulary.js';
import { validateProposalShape } from '../src/policy/proposal.js';

/**
 * Recording a malformed proposal. FR-4.3, ADR 0006.
 *
 * Phase 3's schema made `target.orderId` unconditionally required, which made
 * it impossible to record the one kind of attempt that never resolves to an
 * order. These tests pin the fix: malformed attempts are recordable, resolved
 * proposals are exactly as strict as before, and nothing that is recorded can
 * carry free text.
 */

const oid = () => new mongoose.Types.ObjectId();
const base = () => ({ tenantId: oid(), conversationId: oid(), customerId: oid() });

test('a malformed attempt is recordable with no target and no action type', () => {
  const record = new ActionProposal({
    ...base(),
    validity: 'malformed',
    problemCodes: ['asserted_authorisation', 'order_number_placeholder'],
  });
  assert.equal(record.validateSync(), undefined);
});

test('a resolved proposal is exactly as strict as Phase 3 specified', () => {
  const record = new ActionProposal({
    ...base(),
    actionType: 'order.cancel',
    target: { kind: 'order', orderNumber: '1043' },
  });
  const error = record.validateSync();
  assert.ok(error?.errors?.['target.orderId'], 'a resolved proposal must point at an order');
});

test('validity defaults to resolved, so existing callers keep the strict requirement', () => {
  const record = new ActionProposal({ ...base() });
  assert.equal(record.validity, 'resolved');
  assert.ok(record.validateSync()?.errors?.actionType);
});

test('problem codes are an enum, so free text cannot be recorded through them', () => {
  const record = new ActionProposal({
    ...base(),
    validity: 'malformed',
    problemCodes: ['model said the card number is 4111 1111 1111 1111'],
  });
  const error = record.validateSync();
  assert.ok(
    Object.keys(error?.errors ?? {}).some((path) => path.startsWith('problemCodes')),
    'a non-enumerated problem code must fail validation',
  );
});

test('every code the boundary can emit is one the schema will accept', () => {
  // The cross-check that matters. If the validator could produce a code the
  // schema rejects, the malformed attempt would fail to save -- losing the
  // record in precisely the case the record exists for.
  const badInputs = [
    null,
    { actionType: 'nope', target: 'x', execute: true, mood: 1 },
    { actionType: 'order.cancel', target: { kind: 'customer', orderNumber: 1043, orderId: 'x' } },
    { actionType: 'order.cancel', target: { kind: 'order', orderNumber: 'latest' } },
    { actionType: 'order.cancel', target: { kind: 'order', orderNumber: '<id>' } },
    { actionType: 'order.cancel', target: { kind: 'order', orderNumber: '1' }, evidence: 'x' },
    {
      actionType: 'order.cancel',
      target: { kind: 'order', orderNumber: '1' },
      evidence: [1, { kind: 'vibes', ref: '', snippet: 'x' }],
      reasonCode: 7,
    },
    {
      actionType: 'order.cancel',
      target: { kind: 'order', orderNumber: '1' },
      evidence: Array.from({ length: 21 }, () => ({ kind: 'kb_chunk', ref: 'r' })),
    },
  ];

  const emitted = new Set(badInputs.flatMap((raw) => validateProposalShape(raw).codes));
  assert.ok(emitted.size >= 12, `expected broad coverage of codes, saw ${emitted.size}`);
  for (const code of emitted) {
    assert.ok(PROBLEM_CODES.includes(code), `the validator emitted "${code}", which the schema rejects`);
  }

  const record = new ActionProposal({ ...base(), validity: 'malformed', problemCodes: [...emitted] });
  assert.equal(record.validateSync(), undefined);
});

test('an authorisation claim is countable on its own in the audit', () => {
  assert.ok(PROBLEM_CODES.includes('asserted_authorisation'));
  assert.ok(PROBLEM_CODES.includes('target_does_not_resolve'));
});
