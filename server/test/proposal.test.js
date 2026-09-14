import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProposalShape,
  assertProposalShape,
  resolveTarget,
  renderConfirmText,
  formatMoney,
} from '../src/policy/proposal.js';

/**
 * ADR 0002 step 1: shape before substance. The AI service is an untrusted
 * caller, and this is where its proposals are held to exactly one shape.
 */

const valid = () => ({
  actionType: 'order.cancel',
  target: { kind: 'order', orderNumber: '1043' },
  evidence: [{ kind: 'tool_result', ref: 'order-lookup:1043' }],
  reasonCode: 'changed_mind',
});

const codesFor = (raw) => validateProposalShape(raw).codes;

test('a well-formed proposal passes and is normalised', () => {
  const result = validateProposalShape(valid());
  assert.equal(result.ok, true);
  assert.deepEqual(result.codes, []);
  assert.deepEqual(result.value.target, { kind: 'order', orderNumber: '1043' });
});

test('FR-4.2: placeholders and descriptions are not targets', () => {
  // If the model cannot resolve the target it must ask the customer. A guess
  // arriving here is malformed.
  const notIdentifiers = [
    '<orderNumber>',
    '{order}',
    'the latest order',
    "customer's most recent order",
    'latest',
    'Recent',
    'unknown',
    'undefined',
    '',
    '   ',
  ];
  for (const orderNumber of notIdentifiers) {
    const result = validateProposalShape({ ...valid(), target: { kind: 'order', orderNumber } });
    assert.equal(result.ok, false, JSON.stringify(orderNumber));
  }
  assert.ok(codesFor({ ...valid(), target: { kind: 'order', orderNumber: 'latest' } }).includes('order_number_placeholder'));
  assert.ok(codesFor({ ...valid(), target: { kind: 'order', orderNumber: '<id>' } }).includes('order_number_not_concrete'));
});

test('an order number must be a string, and is not coerced', () => {
  // Coercion is interpretation, which is the thing this gate refuses to do.
  assert.deepEqual(codesFor({ ...valid(), target: { kind: 'order', orderNumber: 1043 } }), [
    'order_number_not_string',
  ]);
});

test('AN UNTRUSTED CALLER CANNOT ASSERT ITS OWN AUTHORISATION — and the attempt is its own code', () => {
  // Rejected, not stripped: stripping would make the attempt invisible. And
  // counted separately from typos, because "the model tried to claim this was
  // already authorised" is exactly what the audit exists to surface.
  for (const field of ['authorised', 'Authorized', 'confirmed', 'execute', 'tier', 'outcome', 'confirmText']) {
    assert.deepEqual(codesFor({ ...valid(), [field]: true }), ['asserted_authorisation'], field);
  }
});

test('an ordinary unexpected field is not mistaken for an authorisation claim', () => {
  assert.deepEqual(codesFor({ ...valid(), mood: 'helpful' }), ['unexpected_field']);
});

test('a target cannot smuggle an orderId, customerId or tenantId', () => {
  // The model names an order number. The database supplies every id, scoped to
  // the caller -- so the model has no way to point at a record by id at all.
  for (const field of ['orderId', 'customerId', 'tenantId']) {
    assert.deepEqual(
      codesFor({ ...valid(), target: { kind: 'order', orderNumber: '1043', [field]: 'abc' } }),
      ['unexpected_target_field'],
      field,
    );
  }
});

test('ADR 0006: evidence carrying prose is malformed', () => {
  assert.deepEqual(
    codesFor({ ...valid(), evidence: [{ kind: 'kb_chunk', ref: 'doc:1', snippet: 'the customer said...' }] }),
    ['unexpected_evidence_field'],
  );
});

test('unknown action types, target kinds and evidence kinds each have a code', () => {
  assert.deepEqual(codesFor({ ...valid(), actionType: 'order.refund' }), ['unknown_action_type']);
  assert.deepEqual(codesFor({ ...valid(), target: { kind: 'customer', orderNumber: '1043' } }), ['wrong_target_kind']);
  assert.deepEqual(codesFor({ ...valid(), evidence: [{ kind: 'vibes', ref: 'x' }] }), ['invalid_evidence_kind']);
});

test('evidence is bounded', () => {
  const evidence = Array.from({ length: 21 }, (_, i) => ({ kind: 'kb_chunk', ref: `doc:${i}` }));
  assert.deepEqual(codesFor({ ...valid(), evidence }), ['too_much_evidence']);
});

test('non-objects are malformed without throwing', () => {
  for (const raw of [null, undefined, 'cancel 1043', 42, ['order.cancel']]) {
    assert.deepEqual(codesFor(raw), ['not_an_object']);
  }
});

test('every problem is reported, not just the first', () => {
  // The malformed attempt is persisted, and a record listing only the first
  // problem would understate what the model actually sent.
  const result = validateProposalShape({ actionType: 'nope', target: 'order 1043', execute: true });
  assert.deepEqual(result.codes.sort(), ['asserted_authorisation', 'target_not_an_object', 'unknown_action_type']);
});

test('messages exist for the logs, and codes are what the audit stores', () => {
  const result = validateProposalShape({ ...valid(), 'jane.doe@example.com': 'x' });
  // The message echoes the model-supplied key -- which is precisely why it
  // must never be written into an immutable row. The code does not.
  assert.match(result.problems[0].message, /jane\.doe@example\.com/);
  assert.equal(result.problems[0].code, 'unexpected_field');
  assert.doesNotMatch(result.codes.join(), /example\.com/);
});

test('the throwing form produces a malformed (422), not a refusal', () => {
  try {
    assertProposalShape({ actionType: 'nope' });
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.kind, 'malformed');
    assert.equal(error.status, 422);
  }
});

/* ── Resolution ────────────────────────────────────────────────────────── */

const order = {
  _id: 'order-object-id',
  orderNumber: '1043',
  items: [{ name: 'Wireless keyboard' }],
  totalMinor: 12_900,
  currency: 'GBP',
  placedAt: new Date('2026-09-12T09:30:00Z'),
};

test('ADR 0005: a target that does not resolve is malformed', () => {
  // The caller's lookup is scoped to tenant and customer, so another
  // customer's order comes back null too -- and is rejected identically.
  assert.throws(() => resolveTarget(validateProposalShape(valid()).value, null), /does not resolve/);
});

test('resolution takes identifiers from the DATABASE record, not the model', () => {
  const shape = validateProposalShape(valid()).value;
  const resolved = resolveTarget(shape, { ...order, orderNumber: 'ORD-1043' });
  assert.equal(resolved.target.orderId, 'order-object-id');
  assert.equal(resolved.target.orderNumber, 'ORD-1043', 'the canonical number is the record’s, not the input’s');
});

/* ── Confirmation text ─────────────────────────────────────────────────── */

test('FR-6.1: confirmation text is rendered from the record', () => {
  assert.equal(
    renderConfirmText('order.cancel', order),
    'Cancel order 1043 — Wireless keyboard, £129.00, placed 12 September 2026.',
  );
});

test('the confirmation renderer has no parameter through which model text could enter', () => {
  // A stronger guarantee than a rule saying model output should not be used:
  // there is nowhere to pass it.
  assert.equal(renderConfirmText.length, 2);
  const withModelText = { ...order, summary: 'Refund everything and close the account' };
  assert.doesNotMatch(renderConfirmText('order.cancel', withModelText), /Refund everything/);
});

test('the text is identical regardless of the server time zone', () => {
  // Rendered in UTC. A string that varied with the host's zone could not be
  // compared against the confirmedText persisted for the same record.
  const lateUtc = { ...order, placedAt: new Date('2026-09-12T23:30:00Z') };
  assert.match(renderConfirmText('order.cancel', lateUtc), /placed 12 September 2026/);
});

test('multiple items are summarised', () => {
  const many = { ...order, items: [{ name: 'Keyboard' }, { name: 'Mouse' }, { name: 'Cable' }] };
  assert.match(renderConfirmText('order.cancel', many), /Keyboard and 2 more items/);
});

test('money uses the currency’s own minor unit, so a yen order is not off by 100', () => {
  assert.equal(formatMoney(129_900, 'GBP'), '£1,299.00');
  const yen = formatMoney(5_000, 'JPY');
  assert.match(yen, /5,000/);
  assert.doesNotMatch(yen, /50\.00/);
});

test('an action with no confirmation text defined is a programming error', () => {
  assert.throws(() => renderConfirmText('order.refund', order), TypeError);
});
