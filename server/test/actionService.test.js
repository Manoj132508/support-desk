import test from 'node:test';
import assert from 'node:assert/strict';
import { makeActionService, idempotencyKeyFor } from '../src/policy/actionService.js';
import { BASELINE_RULES } from '../src/policy/baselineRules.js';
import { makeFakeActionRepo } from './support/fakeActionRepo.js';

/**
 * Propose → confirm → execute. The sequence INV-A depends on.
 *
 * The engine is tested elsewhere as a pure function. These tests are about
 * ORDERING and RECORDING: that nothing is evaluated before it is persisted,
 * that nothing executes without a fresh decision, that every branch leaves a
 * record, and that the cases a real database makes hard to reproduce -- races,
 * a shipment mid-flight, a commit that reports failure -- behave correctly.
 */

const NOW = new Date('2026-09-14T12:00:00Z');
const CTX = { tenantId: 't1' };
const CUSTOMER = 'customer-1';
const OTHER_CUSTOMER = 'customer-2';
const AGENT = 'user-1';

function paidOrder(overrides = {}) {
  return {
    _id: 'order-1',
    __v: 0,
    tenantId: 't1',
    customerId: CUSTOMER,
    orderNumber: '1043',
    status: 'paid',
    items: [{ sku: 'KB-1', name: 'Wireless keyboard', qty: 1, unitPriceMinor: 12_900 }],
    currency: 'GBP',
    totalMinor: 12_900,
    placedAt: new Date('2026-09-12T09:30:00Z'),
    ...overrides,
  };
}

const cancel = (orderNumber = '1043') => ({
  actionType: 'order.cancel',
  target: { kind: 'order', orderNumber },
  evidence: [{ kind: 'tool_result', ref: `order-lookup:${orderNumber}` }],
});

function setup({ orders = [paidOrder()], rules = BASELINE_RULES } = {}) {
  const repo = makeFakeActionRepo({ orders, rules });
  let now = NOW;
  const service = makeActionService({ repo, clock: () => now });
  const propose = (raw = cancel(), customerId = CUSTOMER) =>
    service.propose({ ctx: CTX, customerId, conversationId: 'conv-1', raw, correlationId: 'corr-1' });
  const confirm = (proposalId, customerId = CUSTOMER) =>
    service.confirm({ ctx: CTX, customerId, proposalId, userId: AGENT });
  const reject = (proposalId, customerId = CUSTOMER) =>
    service.reject({ ctx: CTX, customerId, proposalId, userId: AGENT });
  return { repo, service, propose, confirm, reject, setNow: (date) => { now = date; } };
}

const outcomes = (repo) => [...repo.state.outcomesByKey.values()];
const orderIn = (repo, id = 'order-1') => repo.state.orders.get(id);

function rejectsWith(status, kind) {
  return (error) => {
    assert.equal(error.status, status, `expected ${status}, got ${error.status}: ${error.message}`);
    assert.equal(error.kind, kind);
    return true;
  };
}

/* ── Propose ──────────────────────────────────────────────────────────── */

test('ADR 0002: the proposal is persisted BEFORE any policy evaluation', async () => {
  const { repo, propose } = setup();
  await propose();
  const recorded = repo.calls.indexOf('recordProposal');
  assert.ok(recorded >= 0);
  assert.ok(recorded < repo.calls.indexOf('loadRules'), 'rules were loaded before the proposal was recorded');
  assert.ok(recorded < repo.calls.indexOf('recordDecision:proposal'));
});

test('a pre-dispatch order needs confirmation, and nothing is authorised yet', async () => {
  const { repo, propose } = setup();
  const result = await propose();

  assert.equal(result.kind, 'confirm');
  assert.equal(result.decision.ruleKey, 'BASE-CANCEL-PRE-DISPATCH');
  // Pending means NO outcome row, and the order is untouched.
  assert.equal(outcomes(repo).length, 0);
  assert.equal(orderIn(repo).status, 'paid');
  // The proposal-time decision is recorded, so it can survive until confirmation.
  assert.equal(repo.state.decisions.filter((d) => d.stage === 'proposal').length, 1);
});

test('FR-6.1: the confirmation text comes from the record, and is stored with the proposal', async () => {
  const { repo, propose } = setup();
  const result = await propose();
  assert.equal(result.confirmText, 'Cancel order 1043 — Wireless keyboard, £129.00, placed 12 September 2026.');
  assert.equal(repo.state.proposals.get(result.proposalId).confirmText, result.confirmText);
});

test('a delivered order is refused at proposal, and the refusal is recorded', async () => {
  const { repo, propose } = setup({ orders: [paidOrder({ status: 'delivered' })] });
  const result = await propose();

  assert.equal(result.kind, 'refused');
  const [outcome] = outcomes(repo);
  assert.equal(outcome.outcome, 'refused_at_proposal');
  assert.equal(outcome.decisionAtProposal.ruleKey, 'BASE-CANCEL-DELIVERED');
  assert.equal(outcome.decisionAtExecution, null);
  // ADR 0007: the rule's own customer text is available to render.
  assert.match(result.decision.customerMessage, /already been delivered/);
});

test('a dispatched order is escalated, not refused', async () => {
  const { repo, propose } = setup({ orders: [paidOrder({ status: 'dispatched' })] });
  const result = await propose();
  assert.equal(result.kind, 'escalated');
  assert.equal(outcomes(repo)[0].outcome, 'escalated_at_proposal');
});

test('DENY BY DEFAULT end to end: no rules escalates, and says nothing internal to the customer', async () => {
  const { repo, propose } = setup({ rules: [] });
  const result = await propose();
  assert.equal(result.kind, 'escalated');
  assert.equal(result.decision.defaulted, true);
  assert.equal(result.decision.customerMessage, null);
  assert.equal(outcomes(repo)[0].outcome, 'escalated_at_proposal');
});

test('a malformed proposal is recorded as codes and never reaches the engine', async () => {
  const { repo, propose } = setup();
  const result = await propose({ ...cancel(), authorised: true });

  assert.equal(result.kind, 'malformed');
  assert.deepEqual(result.codes, ['asserted_authorisation']);
  const record = repo.state.proposals.get(result.proposalId);
  assert.equal(record.validity, 'malformed');
  assert.deepEqual(record.problemCodes, ['asserted_authorisation']);
  assert.equal(repo.calls.includes('loadRules'), false, 'the engine must never see a malformed proposal');
  assert.equal(repo.state.decisions.length, 0);
  assert.equal(outcomes(repo).length, 0);
});

test('ADR 0005: another customer’s order is indistinguishable from no order', async () => {
  const { repo, propose } = setup({
    orders: [paidOrder(), paidOrder({ _id: 'order-2', orderNumber: '2000', customerId: OTHER_CUSTOMER })],
  });
  const foreign = await propose(cancel('2000'));
  const missing = await propose(cancel('9999'));

  assert.equal(foreign.kind, 'malformed');
  assert.deepEqual(foreign.codes, missing.codes);
  assert.deepEqual(foreign.codes, ['target_does_not_resolve']);
  assert.equal(orderIn(repo, 'order-2').status, 'paid');
});

test('the decision uses the INJECTED clock, so age-based rules replay exactly', async () => {
  const oldOrdersNeedAPerson = {
    ruleKey: 'TENANT-OLD-ORDERS',
    tenantId: 't1',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 1,
    conditions: [{ field: 'order.ageHours', op: 'gt', value: 24 }],
    outcome: 'refuse',
    customerMessage: 'Older orders need a person.',
    internalReason: 'Age limit.',
  };

  const late = setup({ rules: [oldOrdersNeedAPerson] });
  assert.equal((await late.propose()).kind, 'refused'); // ~50h old at NOW

  const early = setup({ rules: [oldOrdersNeedAPerson] });
  early.setNow(new Date('2026-09-12T20:00:00Z')); // ~10h old
  assert.equal((await early.propose()).kind, 'escalated'); // no rule matches → deny by default
});

/* ── Confirm ──────────────────────────────────────────────────────────── */

test('confirming executes once, and records both decisions and the exact confirmed text', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();
  const result = await confirm(proposed.proposalId);

  assert.equal(result.kind, 'executed');
  assert.equal(result.duplicate, false);
  assert.equal(orderIn(repo).status, 'cancelled');

  const [outcome] = outcomes(repo);
  assert.equal(outcome.outcome, 'executed');
  assert.equal(outcome.decisionAtProposal.outcome, 'confirm-required');
  assert.equal(outcome.decisionAtExecution.outcome, 'confirm-required');
  assert.equal(outcome.confirmation.confirmedText, proposed.confirmText);
  assert.equal(outcome.idempotencyKey, idempotencyKeyFor(proposed.proposalId));
  assert.deepEqual(outcome.result, { orderVersionBefore: 0, orderVersionAfter: 1, cancellationRef: 'cxl-1043' });
});

test('ADR 0003 — THE ORDER SHIPS BETWEEN PROPOSAL AND CONFIRMATION: refused at execution', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();

  // The shipping system dispatches the parcel while the customer reads the dialog.
  const stored = orderIn(repo);
  stored.status = 'dispatched';
  stored.__v += 1;

  await assert.rejects(confirm(proposed.proposalId), rejectsWith(409, 'stale'));

  const [outcome] = outcomes(repo);
  assert.equal(outcome.outcome, 'refused_at_execution');
  // BOTH decisions, side by side: "authorised, then refused" is legible.
  assert.equal(outcome.decisionAtProposal.outcome, 'confirm-required');
  assert.equal(outcome.decisionAtExecution.outcome, 'agent-only');
  assert.equal(outcome.decisionAtExecution.ruleKey, 'BASE-CANCEL-DISPATCHED');
  assert.equal(orderIn(repo).status, 'dispatched', 'a shipped order must not be cancelled');
  assert.equal(repo.calls.includes('executeCancellation'), false);
});

test('ADR 0003 — A RULE IS EDITED BETWEEN PROPOSAL AND CONFIRMATION: the new rule applies', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();

  repo.state.rules = [
    ...BASELINE_RULES,
    {
      ruleKey: 'TENANT-FREEZE',
      tenantId: 't1',
      version: 1,
      active: true,
      actionType: 'order.cancel',
      priority: 1,
      conditions: [{ field: 'order.status', op: 'eq', value: 'paid' }],
      outcome: 'refuse',
      customerMessage: 'Cancellations are paused today.',
      internalReason: 'Stock count in progress.',
    },
  ];

  await assert.rejects(confirm(proposed.proposalId), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.customerMessage, 'Cancellations are paused today.');
    assert.equal(error.detail.ruleKey, 'TENANT-FREEZE');
    return true;
  });
  assert.equal(orderIn(repo).status, 'paid');
});

test('the proposal-time decision at confirmation is the RECORDED one, not a re-derivation', async () => {
  // If the rules change, re-deriving "what was decided at proposal time" would
  // silently rewrite history. The recorded decision is what the audit keeps.
  const { repo, propose, confirm } = setup();
  const proposed = await propose();

  repo.state.rules = [
    {
      ruleKey: 'NEW-CATCHALL',
      tenantId: null,
      version: 1,
      active: true,
      actionType: 'order.cancel',
      priority: 1,
      conditions: [],
      outcome: 'confirm-required',
      customerMessage: 'ok',
      internalReason: 'ok',
    },
  ];
  await confirm(proposed.proposalId);

  const [outcome] = outcomes(repo);
  assert.equal(outcome.decisionAtProposal.ruleKey, 'BASE-CANCEL-PRE-DISPATCH');
  assert.equal(outcome.decisionAtExecution.ruleKey, 'NEW-CATCHALL');
});

test('ADR 0003: a duplicate confirmation returns the original result and does not execute again', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();

  const first = await confirm(proposed.proposalId);
  const second = await confirm(proposed.proposalId);

  assert.equal(second.kind, 'executed');
  assert.equal(second.duplicate, true);
  assert.equal(second.outcome._id, first.outcome._id);
  assert.equal(repo.calls.filter((c) => c === 'executeCancellation').length, 1);
  assert.equal(orderIn(repo).__v, 1, 'the order was changed exactly once');
});

test('ADR 0003: two confirmations RACING produce exactly one execution', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();

  const [a, b] = await Promise.all([confirm(proposed.proposalId), confirm(proposed.proposalId)]);

  assert.equal(a.kind, 'executed');
  assert.equal(b.kind, 'executed');
  assert.equal(a.outcome._id, b.outcome._id);
  assert.equal(outcomes(repo).filter((o) => o.outcome === 'executed').length, 1);
  assert.equal(orderIn(repo).__v, 1);
});

test('a version conflict during execution writes nothing, and a retry re-evaluates and succeeds', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();

  repo.state.conflictNextExecute = true;
  await assert.rejects(confirm(proposed.proposalId), rejectsWith(409, 'stale'));
  assert.equal(outcomes(repo).length, 0, 'a conflict must not consume the idempotency key');
  assert.equal(orderIn(repo).status, 'paid');

  const retry = await confirm(proposed.proposalId);
  assert.equal(retry.kind, 'executed');
  // Two execution-stage evaluations were recorded -- one per attempt.
  assert.equal(repo.state.decisions.filter((d) => d.stage === 'execution').length, 2);
});

test('an execution fault records a terminal failure, stores no driver message, and blocks re-execution', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();

  repo.state.failNextExecute = 'fault';
  await assert.rejects(confirm(proposed.proposalId), rejectsWith(500, 'fault'));

  const [outcome] = outcomes(repo);
  assert.equal(outcome.outcome, 'failed');
  assert.deepEqual(outcome.error, { code: 'execution_fault', message: null });
  assert.equal(orderIn(repo).status, 'paid');

  await assert.rejects(confirm(proposed.proposalId), rejectsWith(409, 'stale'));
});

test('THE AMBIGUOUS COMMIT: the write lands, the driver errors, and idempotency reports the truth', async () => {
  // A connection reset after the server applied the write. The service cannot
  // tell from the error whether the cancellation happened -- but the
  // idempotency key can.
  const { repo, propose, confirm } = setup();
  const proposed = await propose();

  repo.state.failNextExecute = 'ambiguous-commit';
  const result = await confirm(proposed.proposalId);

  assert.equal(result.kind, 'executed');
  assert.equal(result.duplicate, true);
  assert.equal(orderIn(repo).status, 'cancelled');
  assert.deepEqual(outcomes(repo).map((o) => o.outcome), ['executed'], 'no false "failed" record');
});

test('INV-D: confirming someone else’s proposal is a 404', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();
  await assert.rejects(confirm(proposed.proposalId, OTHER_CUSTOMER), rejectsWith(404, 'fault'));
  assert.equal(orderIn(repo).status, 'paid');
});

test('a malformed proposal cannot be confirmed, because it was never offered', async () => {
  const { propose, confirm } = setup();
  const malformed = await propose({ ...cancel(), execute: true });
  await assert.rejects(confirm(malformed.proposalId), rejectsWith(404, 'fault'));
});

test('a proposal refused at proposal time cannot be confirmed into execution', async () => {
  const { repo, propose, confirm } = setup({ orders: [paidOrder({ status: 'delivered' })] });
  const refused = await propose();
  await assert.rejects(confirm(refused.proposalId), rejectsWith(409, 'stale'));
  assert.equal(orderIn(repo).status, 'delivered');
});

/* ── Reject ───────────────────────────────────────────────────────────── */

test('rejecting records the customer’s decision, and a repeated rejection is idempotent', async () => {
  const { repo, propose, reject } = setup();
  const proposed = await propose();

  const first = await reject(proposed.proposalId);
  const second = await reject(proposed.proposalId);

  assert.equal(first.kind, 'rejected');
  assert.equal(second.duplicate, true);
  assert.deepEqual(outcomes(repo).map((o) => o.outcome), ['rejected_by_customer']);
  assert.equal(orderIn(repo).status, 'paid');
});

test('a rejected proposal cannot then be confirmed', async () => {
  const { repo, propose, confirm, reject } = setup();
  const proposed = await propose();
  await reject(proposed.proposalId);
  await assert.rejects(confirm(proposed.proposalId), rejectsWith(409, 'stale'));
  assert.equal(orderIn(repo).status, 'paid');
});

test('an executed proposal cannot then be rejected — saying otherwise would be false', async () => {
  const { propose, confirm, reject } = setup();
  const proposed = await propose();
  await confirm(proposed.proposalId);
  await assert.rejects(reject(proposed.proposalId), rejectsWith(409, 'stale'));
});

test('the idempotency key is derived from the proposal and nothing else', () => {
  assert.equal(idempotencyKeyFor('abc'), 'proposal:abc');
  assert.equal(idempotencyKeyFor('abc'), idempotencyKeyFor('abc'));
});

test('a confirm result names the action and the order exactly as they were RECORDED', async () => {
  // The confirmation dialog labels its button from these ("Cancel order 1043"),
  // so they must come from the recorded proposal -- the database's view of the
  // order -- not from anything the advisory tier sent.
  const { repo, propose } = setup();
  const result = await propose();
  const recorded = repo.state.proposals.get(result.proposalId);

  assert.equal(result.actionType, recorded.actionType);
  assert.deepEqual(result.target, { kind: 'order', orderNumber: recorded.target.orderNumber });
});
