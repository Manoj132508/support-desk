import test from 'node:test';
import assert from 'node:assert/strict';
import { makeExpirySweep, DEFAULT_PENDING_TTL_MS } from '../src/policy/expirySweep.js';
import { makeActionService, idempotencyKeyFor } from '../src/policy/actionService.js';
import { BASELINE_RULES } from '../src/policy/baselineRules.js';
import { makeFakeActionRepo } from './support/fakeActionRepo.js';

/**
 * The expiry sweep, run against the same fake repo the action service uses, so
 * the interaction that matters -- a proposal expiring, then someone trying to
 * confirm it -- is tested end to end rather than in two halves.
 */

const START = new Date('2026-09-15T12:00:00Z');
const MINUTES = 60 * 1000;

function paidOrder(overrides = {}) {
  return {
    _id: 'order-1',
    __v: 0,
    tenantId: 't1',
    customerId: 'customer-1',
    orderNumber: '1043',
    status: 'paid',
    items: [{ sku: 'KB-1', name: 'Wireless keyboard', qty: 1, unitPriceMinor: 12_900 }],
    currency: 'GBP',
    totalMinor: 12_900,
    placedAt: new Date('2026-09-14T09:30:00Z'),
    ...overrides,
  };
}

function setup({ orders = [paidOrder()], tenants = ['t1'] } = {}) {
  let now = START;
  const clock = () => now;
  const repo = makeFakeActionRepo({ orders, rules: BASELINE_RULES });

  // The shared fake does not stamp createdAt or tenantId on proposals, and has
  // no tenant listing. Added here rather than in the shared file, so the action
  // service's own tests are unaffected.
  const recordProposal = repo.recordProposal;
  repo.recordProposal = async (ctx, doc) => {
    const proposal = await recordProposal(ctx, doc);
    const stored = repo.state.proposals.get(proposal._id);
    stored.createdAt = clock();
    stored.tenantId = ctx.tenantId;
    return { ...proposal, createdAt: stored.createdAt, tenantId: ctx.tenantId };
  };
  repo.listTenantIds = async () => tenants;
  const pendingQueries = [];
  repo.findPendingProposals = async (ctx, { olderThan, limit }) => {
    pendingQueries.push({ tenantId: ctx.tenantId, olderThan, limit });
    return [...repo.state.proposals.values()]
      .filter((p) => p.tenantId === ctx.tenantId)
      .filter((p) => p.validity === 'resolved')
      .filter((p) => !repo.state.outcomesByProposal.has(String(p._id)))
      .filter((p) => p.createdAt < olderThan)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map((p) => structuredClone(p));
  };
  const recordedCtx = [];
  const recordOutcome = repo.recordOutcome;
  repo.recordOutcome = async (ctx, doc) => {
    recordedCtx.push(ctx.tenantId);
    return recordOutcome(ctx, doc);
  };

  const service = makeActionService({ repo, clock });
  const sweeper = makeExpirySweep({ repo, clock });
  const propose = (tenantId = 't1', customerId = 'customer-1', orderNumber = '1043') =>
    service.propose({
      ctx: { tenantId },
      customerId,
      conversationId: 'conv-1',
      raw: { actionType: 'order.cancel', target: { kind: 'order', orderNumber } },
    });
  const confirm = (proposalId, tenantId = 't1', customerId = 'customer-1') =>
    service.confirm({ ctx: { tenantId }, customerId, proposalId, userId: 'user-1' });

  return {
    repo,
    sweeper,
    propose,
    confirm,
    pendingQueries,
    recordedCtx,
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

test('an undecided proposal older than the TTL expires, and can no longer be confirmed', async () => {
  const { repo, sweeper, propose, confirm, advance } = setup();
  const proposed = await propose();
  assert.equal(proposed.kind, 'confirm');

  advance(DEFAULT_PENDING_TTL_MS + MINUTES);
  const report = await sweeper.sweep();

  assert.equal(report.expired, 1);
  const outcome = repo.state.outcomesByProposal.get(String(proposed.proposalId));
  assert.equal(outcome.outcome, 'expired');
  assert.equal(outcome.decisionAtProposal.outcome, 'confirm-required');
  assert.equal(outcome.decisionAtExecution, null);
  assert.equal(outcome.idempotencyKey, idempotencyKeyFor(proposed.proposalId));

  await assert.rejects(confirm(proposed.proposalId), (error) => error.status === 409);
  assert.equal(repo.state.orders.get('order-1').status, 'paid', 'expiry is a non-execution');
});

test('ADR 0009: nothing times out INTO consent — expiry never executes anything', async () => {
  const { repo, sweeper, propose, advance } = setup();
  await propose();
  advance(DEFAULT_PENDING_TTL_MS * 10);
  await sweeper.sweep();

  assert.equal(repo.calls.includes('executeCancellation'), false);
  assert.equal([...repo.state.outcomesByKey.values()].some((o) => o.outcome === 'executed'), false);
});

test('a proposal younger than the TTL is left alone and can still be confirmed', async () => {
  const { sweeper, propose, confirm, advance } = setup();
  const proposed = await propose();

  advance(DEFAULT_PENDING_TTL_MS - MINUTES);
  const report = await sweeper.sweep();
  assert.equal(report.expired, 0);

  const confirmed = await confirm(proposed.proposalId);
  assert.equal(confirmed.kind, 'executed');
});

test('RACING A CONFIRMATION: an outcome already recorded stands, and the sweep overwrites nothing', async () => {
  const { repo, sweeper, propose, confirm, advance } = setup();
  const proposed = await propose();
  await confirm(proposed.proposalId);

  // A stale listing: the sweep still believes the proposal is pending.
  repo.state.outcomesByProposal.delete(String(proposed.proposalId));

  advance(DEFAULT_PENDING_TTL_MS + MINUTES);
  const report = await sweeper.sweep();

  assert.equal(report.alreadyDecided, 1);
  assert.equal(report.expired, 0);
  const holder = repo.state.outcomesByKey.get(idempotencyKeyFor(proposed.proposalId));
  assert.equal(holder.outcome, 'executed', 'the idempotency key still holds the execution');
});

test('a proposal that was never offered is not recorded as a customer walking away', async () => {
  const { repo, sweeper, propose, advance } = setup();
  const proposed = await propose();
  // Simulate a process that stopped between recording and deciding.
  repo.state.decisions = repo.state.decisions.filter((d) => d.proposalId !== proposed.proposalId);

  advance(DEFAULT_PENDING_TTL_MS + MINUTES);
  const report = await sweeper.sweep();

  assert.equal(report.neverOffered, 1);
  assert.equal(repo.state.outcomesByProposal.has(String(proposed.proposalId)), false);
});

test('proposals already refused or escalated at proposal time are not pending, so not swept', async () => {
  const { repo, sweeper, propose, advance } = setup({ orders: [paidOrder({ status: 'delivered' })] });
  const refused = await propose();
  assert.equal(refused.kind, 'refused');

  advance(DEFAULT_PENDING_TTL_MS * 2);
  const report = await sweeper.sweep();
  assert.equal(report.examined, 0);
  assert.equal(repo.state.outcomesByProposal.get(String(refused.proposalId)).outcome, 'refused_at_proposal');
});

test('TENANT BY TENANT: every read and write happens inside one tenant’s scope', async () => {
  const { sweeper, propose, advance, pendingQueries, recordedCtx } = setup({
    orders: [paidOrder(), paidOrder({ _id: 'order-2', tenantId: 't2', customerId: 'customer-9', orderNumber: '3001' })],
    tenants: ['t1', 't2'],
  });
  await propose('t1', 'customer-1', '1043');
  await propose('t2', 'customer-9', '3001');

  advance(DEFAULT_PENDING_TTL_MS + MINUTES);
  const report = await sweeper.sweep();

  assert.equal(report.tenants, 2);
  assert.equal(report.expired, 2);
  assert.deepEqual(pendingQueries.map((q) => q.tenantId), ['t1', 't2']);
  assert.deepEqual(recordedCtx.slice(-2), ['t1', 't2']);
});

test('the cutoff comes from the injected clock, and the batch is bounded per tenant', async () => {
  const { sweeper, advance, pendingQueries } = setup();
  advance(5 * MINUTES);
  await sweeper.sweep();
  const [query] = pendingQueries;
  assert.equal(query.olderThan.getTime(), START.getTime() + 5 * MINUTES - DEFAULT_PENDING_TTL_MS);
  assert.equal(query.limit, 100);
});

test('a non-positive TTL is refused, since it would expire proposals the moment they are offered', () => {
  assert.throws(() => makeExpirySweep({ repo: {}, ttlMs: 0 }), /positive/);
  assert.throws(() => makeExpirySweep({ repo: {}, ttlMs: -1 }), /positive/);
});
