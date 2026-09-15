import test from 'node:test';
import assert from 'node:assert/strict';
import { makeActionService } from '../src/policy/actionService.js';
import { BASELINE_RULES } from '../src/policy/baselineRules.js';
import { makeFakeActionRepo } from './support/fakeActionRepo.js';

/**
 * ADR 0010 in the action service: which records escalate, with what, and what
 * the result tells the customer's screen.
 *
 * The fake repository commits an escalation with its record or not at all, as
 * the Mongo repository's transaction does, so "no outcome without its ticket"
 * is testable here.
 */

const NOW = new Date('2026-09-14T12:00:00Z');
const CTX = { tenantId: 't1' };
const CUSTOMER = 'customer-1';
const USER = 'user-1';

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
  const service = makeActionService({ repo, clock: () => NOW });
  const propose = (raw = cancel()) =>
    service.propose({ ctx: CTX, customerId: CUSTOMER, conversationId: 'conv-1', raw, correlationId: 'corr-1' });
  const confirm = (proposalId) => service.confirm({ ctx: CTX, customerId: CUSTOMER, proposalId, userId: USER });
  const reject = (proposalId) => service.reject({ ctx: CTX, customerId: CUSTOMER, proposalId, userId: USER });
  return { repo, propose, confirm, reject };
}

const outcomes = (repo) => [...repo.state.outcomesByKey.values()];
const escalations = (repo) => repo.state.escalations;

async function caught(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

/* ── At proposal ──────────────────────────────────────────────────────── */

test('FR-8: a dispatched order escalates with its outcome, as the system, into the customer’s conversation', async () => {
  const { repo, propose } = setup({ orders: [paidOrder({ status: 'dispatched' })] });
  const result = await propose();

  assert.equal(result.kind, 'escalated');
  assert.equal(result.escalated, true);
  assert.deepEqual(escalations(repo), [
    {
      conversationId: 'conv-1',
      customerId: CUSTOMER,
      reason: 'policy_agent_only',
      actor: { kind: 'system' },
      correlationId: 'corr-1',
      proposalId: result.proposalId,
    },
  ]);
  assert.equal(outcomes(repo)[0].outcome, 'escalated_at_proposal');
});

test('deny by default escalates too: no rule answered the customer', async () => {
  const { repo, propose } = setup({ rules: [] });
  const result = await propose();
  assert.equal(result.escalated, true);
  assert.equal(escalations(repo)[0].reason, 'policy_agent_only');
});

test('a refusal whose rule explains itself is not escalated: the customer is offered a person instead', async () => {
  const { repo, propose } = setup({ orders: [paidOrder({ status: 'delivered' })] });
  const result = await propose();
  assert.equal(result.kind, 'refused');
  assert.equal(result.escalated, false);
  assert.equal(escalations(repo).length, 0);
  assert.equal(outcomes(repo)[0].outcome, 'refused_at_proposal');
});

test('ADR 0007: a refusal whose rule has no customer message escalates, because the fallback promises a colleague', async () => {
  const silentRefusal = {
    ruleKey: 'TENANT-SILENT',
    tenantId: 't1',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 1,
    conditions: [{ field: 'order.status', op: 'eq', value: 'paid' }],
    outcome: 'refuse',
    customerMessage: '',
    internalReason: 'Nobody wrote the customer sentence.',
  };
  const { repo, propose } = setup({ rules: [...BASELINE_RULES, silentRefusal] });
  const result = await propose();

  assert.equal(result.kind, 'refused');
  assert.equal(result.escalated, true);
  assert.equal(escalations(repo)[0].reason, 'policy_refused');
});

test('a malformed proposal escalates, and its ticket names the new proposal', async () => {
  const { repo, propose } = setup();
  const result = await propose({ ...cancel(), authorised: true });
  assert.equal(result.kind, 'malformed');
  assert.equal(result.escalated, true);
  assert.equal(escalations(repo).length, 1);
  assert.equal(escalations(repo)[0].reason, 'proposal_malformed');
  assert.equal(escalations(repo)[0].proposalId, result.proposalId);
});

test('an order number that does not resolve escalates as malformed too', async () => {
  const { repo, propose } = setup();
  const result = await propose(cancel('9999'));
  assert.equal(result.escalated, true);
  assert.equal(escalations(repo)[0].reason, 'proposal_malformed');
});

test('a proposal waiting for confirmation escalates nothing: the customer decides', async () => {
  const { repo, propose } = setup();
  assert.equal((await propose()).kind, 'confirm');
  assert.equal(escalations(repo).length, 0);
});

test('ADR 0010: if the ticket cannot be written, the outcome is not recorded either', async () => {
  const { repo, propose } = setup({ orders: [paidOrder({ status: 'dispatched' })] });
  repo.state.failNextEscalation = true;
  await assert.rejects(propose(), /ticket write failed/);
  assert.equal(outcomes(repo).length, 0);
  assert.equal(escalations(repo).length, 0);
});

/* ── At execution ─────────────────────────────────────────────────────── */

test('ADR 0010 at execution: an order that ships before confirmation is refused, escalated, and the 409 says so', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();

  const stored = repo.state.orders.get('order-1');
  stored.status = 'dispatched';
  stored.__v += 1;

  const error = await caught(confirm(proposed.proposalId));
  assert.equal(error.status, 409);
  assert.equal(error.escalated, true);
  assert.equal(outcomes(repo)[0].outcome, 'refused_at_execution');
  assert.deepEqual(escalations(repo), [
    {
      conversationId: 'conv-1',
      customerId: CUSTOMER,
      reason: 'policy_agent_only',
      actor: { kind: 'system' },
      correlationId: null,
      proposalId: proposed.proposalId,
    },
  ]);
});

test('a rule edited to refuse, with its own message, refuses at execution without escalating', async () => {
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

  const error = await caught(confirm(proposed.proposalId));
  assert.equal(error.status, 409);
  assert.equal(error.escalated, false);
  assert.equal(escalations(repo).length, 0);
});

test('a terminal execution failure escalates, and the fault says a colleague is coming', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();
  repo.state.failNextExecute = 'fault';

  const error = await caught(confirm(proposed.proposalId));
  assert.equal(error.status, 500);
  assert.equal(error.escalated, true);
  assert.equal(outcomes(repo)[0].outcome, 'failed');
  assert.equal(escalations(repo)[0].reason, 'execution_failed');
  assert.equal(escalations(repo)[0].proposalId, proposed.proposalId);
});

test('a failure that cannot even be recorded promises nothing, and the customer can simply try again', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();
  repo.state.failNextExecute = 'fault';
  repo.state.failNextEscalation = true;

  const error = await caught(confirm(proposed.proposalId));
  assert.equal(error.status, 500);
  assert.equal(error.escalated, false);
  assert.equal(outcomes(repo).length, 0);

  assert.equal((await confirm(proposed.proposalId)).kind, 'executed');
});

test('the ambiguous commit escalates nothing: the action happened', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();
  repo.state.failNextExecute = 'ambiguous-commit';
  assert.equal((await confirm(proposed.proposalId)).kind, 'executed');
  assert.equal(escalations(repo).length, 0);
});

test('a version conflict escalates nothing: nothing was recorded, and a retry re-evaluates', async () => {
  const { repo, propose, confirm } = setup();
  const proposed = await propose();
  repo.state.conflictNextExecute = true;
  const error = await caught(confirm(proposed.proposalId));
  assert.equal(error.status, 409);
  assert.equal(error.escalated, false);
  assert.equal(escalations(repo).length, 0);
});

test('confirming and rejecting escalate nothing: those are the customer’s own decisions', async () => {
  const { repo, propose, confirm, reject } = setup({
    orders: [paidOrder(), paidOrder({ _id: 'order-2', orderNumber: '1044' })],
  });
  await confirm((await propose()).proposalId);
  await reject((await propose(cancel('1044'))).proposalId);
  assert.deepEqual(outcomes(repo).map((o) => o.outcome).sort(), ['executed', 'rejected_by_customer']);
  assert.equal(escalations(repo).length, 0);
});
