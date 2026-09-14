import test from 'node:test';
import assert from 'node:assert/strict';
import { framesForProposalResult, DOWNSTREAM_PROPOSAL_EVENTS } from '../src/policy/proposalFrames.js';

/**
 * The frames a CUSTOMER receives about a proposal.
 *
 * These are built from the action service's result, never from the advisory
 * tier's raw proposal, and from an allowlist of fields -- because this stream
 * serves customers, and a rule key or a problem code in it would describe the
 * policy boundary to the person it constrains (ADR 0007).
 */

const decision = {
  ruleId: 'r1',
  ruleKey: 'BASE-CANCEL-DISPATCHED',
  ruleVersion: 2,
  outcome: 'agent-only',
  matched: ['order.status eq "dispatched"'],
  customerMessage: "This order has already been dispatched, so I can't cancel it myself.",
  internalReason: 'Post-dispatch cancellation needs a carrier interception request.',
};

const INTERNAL = ['ruleKey', 'BASE-', 'ruleVersion', 'matched', 'internalReason', 'carrier interception', 'problemCodes', 'asserted_authorisation', 'idempotencyKey'];

function assertNothingInternal(frames) {
  const text = JSON.stringify(frames);
  for (const internal of INTERNAL) {
    assert.ok(!text.includes(internal), `a customer frame must not contain ${internal}`);
  }
}

test('confirmation-required becomes a proposal frame with exactly what the dialog needs', () => {
  const frames = framesForProposalResult({
    kind: 'confirm',
    proposalId: 'p1',
    actionType: 'order.cancel',
    target: { kind: 'order', orderNumber: '1043' },
    confirmText: 'Cancel order 1043 — Wireless keyboard, £129.00, placed 12 September 2026.',
    decision: { ...decision, outcome: 'confirm-required' },
  });

  assert.deepEqual(frames, [
    {
      event: 'proposal',
      data: {
        id: 'p1',
        actionType: 'order.cancel',
        target: { kind: 'order', orderNumber: '1043' },
        confirmText: 'Cancel order 1043 — Wireless keyboard, £129.00, placed 12 September 2026.',
      },
    },
  ]);
  assertNothingInternal(frames);
});

test('a refusal becomes a policy notice carrying only the rule’s customer text', () => {
  const frames = framesForProposalResult({ kind: 'refused', proposalId: 'p2', decision: { ...decision, outcome: 'refuse' } });
  assert.deepEqual(frames, [
    {
      event: 'policy',
      data: {
        kind: 'refused',
        outcome: 'refused_at_proposal',
        proposalId: 'p2',
        customerMessage: decision.customerMessage,
      },
    },
  ]);
  assertNothingInternal(frames);
});

test('an escalation renders in the policy language too, with its precise outcome', () => {
  const [{ event, data }] = framesForProposalResult({ kind: 'escalated', proposalId: 'p3', decision });
  assert.equal(event, 'policy');
  // `kind` stays inside the client's four-kind taxonomy, so it renders as a
  // policy notice rather than an error (Phase 4 §5).
  assert.equal(data.kind, 'refused');
  assert.equal(data.outcome, 'escalated_at_proposal');
});

test('a fail-closed decision with no customer text sends none, and the client falls back', () => {
  const [{ data }] = framesForProposalResult({
    kind: 'escalated',
    proposalId: 'p4',
    decision: { ...decision, customerMessage: null },
  });
  assert.equal(data.customerMessage, null);
});

test('a malformed attempt tells the customer nothing about why', () => {
  const frames = framesForProposalResult({
    kind: 'malformed',
    proposalId: 'p5',
    codes: ['asserted_authorisation'],
  });
  assert.deepEqual(frames, [
    { event: 'policy', data: { kind: 'malformed', outcome: null, proposalId: 'p5', customerMessage: null } },
  ]);
  assertNothingInternal(frames);
});

test('an unrecognised result is a programming error, never an invented decision', () => {
  assert.throws(() => framesForProposalResult({ kind: 'approved', proposalId: 'p6' }), /Unknown proposal result/);
  assert.throws(() => framesForProposalResult(undefined), /Unknown proposal result/);
});

test('every frame this builds uses an event the relay allows handlers to emit', () => {
  const results = [
    { kind: 'confirm', proposalId: 'a', actionType: 'order.cancel', target: { orderNumber: '1' }, confirmText: 't' },
    { kind: 'refused', proposalId: 'b', decision },
    { kind: 'escalated', proposalId: 'c', decision },
    { kind: 'malformed', proposalId: 'd' },
  ];
  for (const result of results) {
    for (const frame of framesForProposalResult(result)) {
      assert.ok(DOWNSTREAM_PROPOSAL_EVENTS.includes(frame.event), frame.event);
    }
  }
});
