import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makeProposalsRouter, publicOutcome } from '../src/routes/proposals.js';
import { errorEnvelope } from '../src/middleware/errorEnvelope.js';
import { AppError } from '../src/errors/AppError.js';

/**
 * The confirm and reject routes, with a fake action service.
 *
 * The service's own behaviour is tested elsewhere. What is asserted here is the
 * route's job: who may call it, where the identifiers come from, and -- the part
 * most likely to leak -- what the response is allowed to contain.
 *
 * Kept to a handful of confirm calls, because the confirm rate limiter is a
 * module-level store shared by every app in this process.
 */

const CUSTOMER = { id: 'u1', role: 'customer', tenantId: 't1', customerId: 'c1' };
const AGENT = { id: 'u2', role: 'agent', tenantId: 't1', customerId: null };

function storedOutcome(overrides = {}) {
  return {
    _id: 'out1',
    proposalId: 'p1',
    outcome: 'executed',
    idempotencyKey: 'proposal:p1',
    decisionAtProposal: {
      ruleKey: 'BASE-CANCEL-PRE-DISPATCH',
      ruleVersion: 1,
      outcome: 'confirm-required',
      matched: ['order.status in ["placed","paid","packed"]'],
    },
    decisionAtExecution: {
      ruleKey: 'BASE-CANCEL-PRE-DISPATCH',
      ruleVersion: 1,
      outcome: 'confirm-required',
      matched: [],
    },
    confirmation: { userId: 'u1', at: '2026-09-14T12:00:00.000Z', confirmedText: 'Cancel order 1043' },
    result: { orderVersionBefore: 0, orderVersionAfter: 1, cancellationRef: 'cxl-o1' },
    ...overrides,
  };
}

function fakeService({ confirm, reject } = {}) {
  const calls = [];
  return {
    calls,
    async confirm(args) {
      calls.push(['confirm', args]);
      return confirm ? confirm(args) : { kind: 'executed', duplicate: false, outcome: storedOutcome() };
    },
    async reject(args) {
      calls.push(['reject', args]);
      return reject
        ? reject(args)
        : { kind: 'rejected', duplicate: false, outcome: storedOutcome({ outcome: 'rejected_by_customer', result: null }) };
    },
  };
}

async function post(path, { user, service, body }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.correlationId = 'corr-test';
    if (user) {
      req.user = user;
      req.tenantId = user.tenantId;
    }
    next();
  });
  app.use('/api/proposals', makeProposalsRouter({ service }));
  app.use(errorEnvelope);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('a customer confirmation returns the outcome WITHOUT any policy detail', async () => {
  const service = fakeService();
  const { status, body } = await post('/api/proposals/p1/confirm', { user: CUSTOMER, service });

  assert.equal(status, 200);
  assert.deepEqual(body, {
    outcome: { proposalId: 'p1', outcome: 'executed', at: '2026-09-14T12:00:00.000Z', cancellationRef: 'cxl-o1' },
    duplicate: false,
  });

  // ADR 0007. The stored outcome carries both decisions; returning it as-is
  // would hand the customer a map of the policy boundary on every confirmation.
  const text = JSON.stringify(body);
  for (const internal of ['BASE-', 'ruleKey', 'decisionAt', 'matched', 'idempotencyKey', 'confirmedText']) {
    assert.ok(!text.includes(internal), `the response must not contain ${internal}`);
  }
});

test('every identifier comes from the SESSION — a request body cannot choose whose proposal it confirms', async () => {
  const service = fakeService();
  await post('/api/proposals/p1/confirm', {
    user: CUSTOMER,
    service,
    body: { customerId: 'someone-else', tenantId: 't-other', userId: 'u-other', proposalId: 'p-other' },
  });

  const [, args] = service.calls[0];
  assert.equal(args.customerId, 'c1');
  assert.equal(args.userId, 'u1');
  assert.equal(args.proposalId, 'p1', 'the proposal id comes from the URL');
  assert.equal(args.ctx.tenantId, 't1');
});

test('ADR 0009: an agent cannot confirm on a customer’s behalf through this route', async () => {
  const service = fakeService();
  const { status } = await post('/api/proposals/p1/confirm', { user: AGENT, service });
  assert.equal(status, 403);
  assert.equal(service.calls.length, 0);
});

test('no session is 401, and the service is never reached', async () => {
  const service = fakeService();
  const { status } = await post('/api/proposals/p1/reject', { service });
  assert.equal(status, 401);
  assert.equal(service.calls.length, 0);
});

test('a refusal at execution is a 409 with the rule’s customer text and no rule detail', async () => {
  const service = fakeService({
    confirm: () => {
      throw AppError.stale('Refused at execution by BASE-CANCEL-DISPATCHED', {
        customerMessage: "This order has already been dispatched, so I can't cancel it myself.",
        detail: { ruleKey: 'BASE-CANCEL-DISPATCHED', ruleVersion: 1, stage: 'execution' },
      });
    },
  });
  const { status, body } = await post('/api/proposals/p1/confirm', { user: CUSTOMER, service });

  assert.equal(status, 409);
  assert.equal(body.kind, 'stale');
  assert.match(body.customerMessage, /already been dispatched/);
  assert.equal(body.detail, null, 'the error envelope strips rule detail for a customer');
});

test('someone else’s proposal is a generic 404', async () => {
  const service = fakeService({
    confirm: () => {
      throw AppError.notFound();
    },
  });
  const { status, body } = await post('/api/proposals/p1/confirm', { user: CUSTOMER, service });
  assert.equal(status, 404);
  assert.equal(body.customerMessage, null);
  assert.equal(body.detail, null);
});

test('a duplicate confirmation is a 200 carrying the original result', async () => {
  const service = fakeService({
    confirm: () => ({ kind: 'executed', duplicate: true, outcome: storedOutcome() }),
  });
  const { status, body } = await post('/api/proposals/p1/confirm', { user: CUSTOMER, service });
  assert.equal(status, 200);
  assert.equal(body.duplicate, true);
  assert.equal(body.outcome.outcome, 'executed');
});

test('a rejection records the customer’s decision', async () => {
  const service = fakeService();
  const { status, body } = await post('/api/proposals/p1/reject', { user: CUSTOMER, service });
  assert.equal(status, 200);
  assert.equal(body.outcome.outcome, 'rejected_by_customer');
  assert.equal(body.outcome.cancellationRef, null);
});

test('a customer login with no linked profile owns no proposals', async () => {
  const service = fakeService();
  const { status } = await post('/api/proposals/p1/reject', {
    user: { ...CUSTOMER, customerId: null },
    service,
  });
  assert.equal(status, 404);
  assert.equal(service.calls.length, 0);
});

test('the public outcome is built from an allowlist, not by deleting fields', () => {
  assert.deepEqual(Object.keys(publicOutcome(storedOutcome())).sort(), [
    'at',
    'cancellationRef',
    'outcome',
    'proposalId',
  ]);
});
