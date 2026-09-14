import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeAuditQuery,
  parseAuditQuery,
  encodeCursor,
  decodeCursor,
  kindOf,
  ATTEMPT_KINDS,
  STOPPED_KINDS,
} from '../src/policy/auditQuery.js';
import { OUTCOMES } from '../src/db/models/index.js';

/**
 * The audit query, answering: what did the assistant try to do that it was not
 * allowed to do? Refusals and malformed attempts are in by default, pages do not
 * shift as new attempts arrive, and a filter the query does not understand is an
 * error rather than something quietly ignored.
 */

const CTX = { tenantId: 't1' };
const id = (n) => n.toString(16).padStart(24, '0');
const at = (minute) => new Date(Date.UTC(2026, 8, 14, 12, minute));
const CUSTOMER = id(900);

const decision = (ruleKey, outcome) => ({ ruleId: null, ruleKey, ruleVersion: 1, outcome, matched: [] });

function attempt(n, overrides = {}) {
  return {
    _id: id(n),
    tenantId: 't1',
    createdAt: at(n),
    validity: 'resolved',
    actionType: 'order.cancel',
    customerId: CUSTOMER,
    conversationId: id(500),
    target: { kind: 'order', orderNumber: `10${n}` },
    problemCodes: [],
    outcome: null,
    proposalDecision: null,
    ...overrides,
  };
}

function fixtures() {
  return [
    attempt(1, {
      outcome: {
        outcome: 'executed',
        createdAt: at(2),
        decisionAtProposal: decision('BASE-CANCEL-PRE-DISPATCH', 'confirm-required'),
        decisionAtExecution: decision('BASE-CANCEL-PRE-DISPATCH', 'confirm-required'),
        confirmation: { userId: id(700) },
      },
    }),
    attempt(2, {
      outcome: { outcome: 'refused_at_proposal', createdAt: at(2), decisionAtProposal: decision('BASE-CANCEL-DELIVERED', 'refuse'), decisionAtExecution: null },
    }),
    attempt(3, {
      validity: 'malformed',
      actionType: undefined,
      target: undefined,
      problemCodes: ['asserted_authorisation'],
    }),
    attempt(4, { proposalDecision: decision('BASE-CANCEL-PRE-DISPATCH', 'confirm-required') }),
    attempt(5, {
      outcome: {
        outcome: 'refused_at_execution',
        createdAt: at(9),
        decisionAtProposal: decision('BASE-CANCEL-PRE-DISPATCH', 'confirm-required'),
        decisionAtExecution: decision('BASE-CANCEL-DISPATCHED', 'agent-only'),
        confirmation: { userId: id(701) },
      },
    }),
    attempt(6, {
      outcome: { outcome: 'rejected_by_customer', createdAt: at(7), decisionAtProposal: decision('BASE-CANCEL-PRE-DISPATCH', 'confirm-required'), decisionAtExecution: null },
    }),
    attempt(7, { tenantId: 't2', customerId: id(901) }),
  ];
}

function makeFakeAuditRepo(rows) {
  const state = { rows: structuredClone(rows), calls: [] };
  return {
    state,
    async findAttempts(ctx, { kinds, actionType, customerId, from, to, before, limit }) {
      state.calls.push({ tenantId: ctx.tenantId, kinds, actionType, customerId, limit });
      return state.rows
        .filter((row) => row.tenantId === ctx.tenantId)
        .filter((row) => !kinds || kinds.includes(kindOf(row)))
        .filter((row) => !actionType || row.actionType === actionType)
        .filter((row) => !customerId || row.customerId === customerId)
        .filter((row) => !from || row.createdAt >= from)
        .filter((row) => !to || row.createdAt <= to)
        .filter(
          (row) =>
            !before ||
            row.createdAt < before.createdAt ||
            (row.createdAt.getTime() === before.createdAt.getTime() && row._id < before.id),
        )
        .sort((a, b) => b.createdAt - a.createdAt || (a._id < b._id ? 1 : -1))
        .slice(0, limit)
        .map((row) => structuredClone(row));
    },
  };
}

function setup(rows = fixtures()) {
  const repo = makeFakeAuditRepo(rows);
  return { repo, audit: makeAuditQuery({ repo }) };
}

async function rejects422(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, 422, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test('FR-11.2: by default EVERYTHING is included — refusals, malformed attempts, pending, executed', async () => {
  const { audit } = setup();
  const { entries } = await audit.list(CTX, {});
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ['rejected_by_customer', 'refused_at_execution', 'pending', 'malformed', 'refused_at_proposal', 'executed'],
  );
});

test('another tenant’s attempts never appear', async () => {
  const { audit, repo } = setup();
  const { entries } = await audit.list(CTX, {});
  assert.ok(!entries.some((entry) => entry.customerId === id(901)));
  assert.equal(repo.state.calls[0].tenantId, 't1');
});

test('the "stopped" preset answers the question the audit exists for', async () => {
  const { audit } = setup();
  const { entries } = await audit.list(CTX, { preset: 'stopped' });
  assert.deepEqual(
    entries.map((entry) => entry.kind).sort(),
    ['malformed', 'refused_at_execution', 'refused_at_proposal'],
  );
});

test('a customer declining is not the assistant being stopped', () => {
  assert.ok(!STOPPED_KINDS.includes('rejected_by_customer'));
  assert.ok(STOPPED_KINDS.includes('malformed'), 'an attempt that never reached the engine still counts');
});

test('kind narrows the results, and a comma list is accepted', async () => {
  const { audit } = setup();
  const { entries } = await audit.list(CTX, { kind: 'executed,pending' });
  assert.deepEqual(entries.map((entry) => entry.kind).sort(), ['executed', 'pending']);
});

test('AN UNRECOGNISED FILTER IS AN ERROR, not silently ignored', async () => {
  // A lead who types kinds= instead of kind= must not get back an unfiltered
  // list they believe is filtered.
  const { audit } = setup();
  await rejects422(audit.list(CTX, { kinds: 'refused_at_proposal' }), /unknown filter "kinds"/);
});

test('a repeated parameter is an error rather than a guess about which one wins', async () => {
  const { audit } = setup();
  await rejects422(audit.list(CTX, { kind: ['executed', 'pending'] }), /more than once/);
});

test('unknown kinds, conflicting kind and preset, and a bad preset are all refused', async () => {
  const { audit } = setup();
  await rejects422(audit.list(CTX, { kind: 'approved' }), /unknown kind: approved/);
  await rejects422(audit.list(CTX, { kind: 'executed', preset: 'stopped' }), /not both/);
  await rejects422(audit.list(CTX, { preset: 'everything' }), /preset must be/);
});

test('each kind of entry carries what staff need to explain it', async () => {
  const { audit } = setup();
  const { entries } = await audit.list(CTX, {});
  const byKind = Object.fromEntries(entries.map((entry) => [entry.kind, entry]));

  assert.deepEqual(byKind.malformed.problemCodes, ['asserted_authorisation']);
  assert.equal(byKind.malformed.target, null);
  assert.equal(byKind.malformed.decisionAtProposal, null);

  // A pending attempt has no outcome yet, but its proposal-time decision exists.
  assert.equal(byKind.pending.decisionAtProposal.outcome, 'confirm-required');
  assert.equal(byKind.pending.decidedAt, null);

  // Authorised, then refused: both decisions, side by side.
  assert.equal(byKind.refused_at_execution.decisionAtProposal.outcome, 'confirm-required');
  assert.equal(byKind.refused_at_execution.decisionAtExecution.ruleKey, 'BASE-CANCEL-DISPATCHED');
  assert.equal(byKind.refused_at_execution.confirmedBy, id(701));

  assert.deepEqual(byKind.executed.target, { kind: 'order', orderNumber: '101' });
});

test('keyset pagination walks every attempt exactly once', async () => {
  const { audit } = setup();
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const query = cursor ? { limit: '2', cursor } : { limit: '2' };
    const { entries, page } = await audit.list(CTX, query);
    seen.push(...entries.map((entry) => entry.id));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);

  assert.equal(pages, 3);
  assert.equal(seen.length, 6);
  assert.equal(new Set(seen).size, 6);
});

test('A NEW ATTEMPT ARRIVING MID-PAGING causes no duplicate and no skip — the reason for keyset', async () => {
  // With offset paging, a row appended at the top pushes the next page down by
  // one: the last row of page one would be shown again on page two.
  const { audit, repo } = setup();
  const first = await audit.list(CTX, { limit: '3' });

  repo.state.rows.push(attempt(50, { outcome: { outcome: 'refused_at_proposal', createdAt: at(50) } }));

  const second = await audit.list(CTX, { limit: '3', cursor: first.page.nextCursor });
  const ids = [...first.entries, ...second.entries].map((entry) => entry.id);

  assert.equal(new Set(ids).size, ids.length, 'no attempt is shown twice');
  assert.equal(ids.length, 6, 'no older attempt is skipped');
  assert.ok(!ids.includes(id(50)), 'the new attempt belongs on a fresh first page');
});

test('the repo is asked for one extra row, so no count query is needed', async () => {
  const { audit, repo } = setup();
  await audit.list(CTX, { limit: '4' });
  assert.equal(repo.state.calls[0].limit, 5);
});

test('a tampered cursor, a bad limit, bad dates and a bad id are refused', async () => {
  const { audit } = setup();
  await rejects422(audit.list(CTX, { cursor: 'not-a-cursor' }), /cursor is not valid/);
  for (const limit of ['0', '101', 'ten', '2.5']) {
    await rejects422(audit.list(CTX, { limit }), /limit must be/);
  }
  await rejects422(audit.list(CTX, { from: 'yesterday' }), /from must be a date/);
  await rejects422(audit.list(CTX, { from: '2026-09-15', to: '2026-09-14' }), /from must not be after to/);
  await rejects422(audit.list(CTX, { customerId: 'robert' }), /customerId is not a valid id/);
});

test('valid filters reach the repo intact', async () => {
  const { audit, repo } = setup();
  await audit.list(CTX, { actionType: 'order.cancel', customerId: CUSTOMER });
  assert.equal(repo.state.calls[0].actionType, 'order.cancel');
  assert.equal(repo.state.calls[0].customerId, CUSTOMER);
});

test('a cursor round-trips', () => {
  const cursor = encodeCursor({ createdAt: at(3), id: id(3) });
  assert.deepEqual(decodeCursor(cursor), { createdAt: at(3), id: id(3) });
});

test('the parser rejects nothing it should accept', () => {
  assert.equal(parseAuditQuery({}).ok, true);
  assert.equal(parseAuditQuery({ preset: 'stopped', limit: '100' }).ok, true);
});

test('every terminal outcome is a queryable kind, alongside malformed and pending', () => {
  // A drift guard: an outcome added to the schema but not to the audit would be
  // recorded and then impossible to filter for.
  for (const outcome of OUTCOMES) assert.ok(ATTEMPT_KINDS.includes(outcome), outcome);
  assert.ok(ATTEMPT_KINDS.includes('malformed'));
  assert.ok(ATTEMPT_KINDS.includes('pending'));
});
