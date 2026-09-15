import { ConcurrentModificationError } from '../../src/policy/actionService.js';

/**
 * An in-memory repo with the SAME GUARANTEES the Mongo repo must provide.
 *
 * A fake that is more forgiving than the real thing tests nothing, and this
 * project has already learned that twice (see ai-service/tests/fakes.py). So
 * this one enforces the properties the service relies on:
 *
 *   - the idempotency key is unique: a second outcome for the same key returns
 *     the existing row with `duplicate: true`, never a second row;
 *   - execution is atomic: the order change and the outcome insert happen
 *     together or not at all, with no await between check and write;
 *   - execution is conditional on the order version, like optimistic
 *     concurrency in Mongoose;
 *   - an escalation commits with the record that caused it: if the escalation
 *     cannot be written, neither is the proposal or outcome (ADR 0010).
 *
 * And it can be told to misbehave in the ways a real database does: a version
 * conflict, a fault, a commit followed by an error, and a failed ticket write.
 */

const clone = (value) => (value === null || value === undefined ? value : structuredClone(value));

export function makeFakeActionRepo({ orders = [], rules = [] } = {}) {
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${++counter}`;
  const calls = [];

  const state = {
    rules: [...rules],
    orders: new Map(orders.map((order) => [String(order._id), structuredClone(order)])),
    proposals: new Map(),
    decisions: [],
    outcomesByKey: new Map(),
    outcomesByProposal: new Map(),
    escalations: [],
    conflictNextExecute: false,
    failNextExecute: null, // 'fault' | 'ambiguous-commit'
    failNextEscalation: false,
  };

  function insertOutcome(doc) {
    const existing = state.outcomesByKey.get(doc.idempotencyKey);
    if (existing) return { outcome: clone(existing), duplicate: true };
    const outcome = { _id: nextId('outcome'), ...structuredClone(doc) };
    state.outcomesByKey.set(doc.idempotencyKey, outcome);
    state.outcomesByProposal.set(String(doc.proposalId), outcome);
    return { outcome: clone(outcome), duplicate: false };
  }

  /** Called BEFORE the record it accompanies is stored, and synchronously, so a
   *  failure here leaves nothing behind -- the in-memory stand-in for rolling
   *  back the shared transaction. */
  function escalate(escalation, proposalId) {
    calls.push(`escalate:${escalation.reason}`);
    if (state.failNextEscalation) {
      state.failNextEscalation = false;
      throw new Error('ticket write failed');
    }
    state.escalations.push({ ...structuredClone(escalation), proposalId });
  }

  const repo = {
    calls,
    state,

    async loadRules(ctx, actionType) {
      calls.push('loadRules');
      return state.rules.filter((rule) => rule.actionType === actionType);
    },

    async countRecentOrders(ctx, customerId, since) {
      calls.push('countRecentOrders');
      return [...state.orders.values()].filter(
        (order) => order.customerId === customerId && order.placedAt >= since,
      ).length;
    },

    async findCustomerOrder(ctx, customerId, orderNumber) {
      calls.push('findCustomerOrder');
      const order = [...state.orders.values()].find(
        (candidate) => candidate.customerId === customerId && candidate.orderNumber === orderNumber,
      );
      return clone(order ?? null);
    },

    async findOrderById(ctx, customerId, orderId) {
      calls.push('findOrderById');
      const order = state.orders.get(String(orderId));
      return order && order.customerId === customerId ? clone(order) : null;
    },

    async recordProposal(ctx, doc, { escalation = null } = {}) {
      calls.push('recordProposal');
      const proposal = { _id: nextId('proposal'), ...structuredClone(doc) };
      if (escalation) escalate(escalation, proposal._id);
      state.proposals.set(proposal._id, proposal);
      return clone(proposal);
    },

    async findProposal(ctx, customerId, proposalId) {
      calls.push('findProposal');
      const proposal = state.proposals.get(String(proposalId));
      return proposal && proposal.customerId === customerId ? clone(proposal) : null;
    },

    async recordDecision(ctx, row) {
      calls.push(`recordDecision:${row.stage}`);
      if (
        row.stage === 'proposal' &&
        state.decisions.some((d) => d.proposalId === row.proposalId && d.stage === 'proposal')
      ) {
        // Mirrors the partial unique index: one proposal-stage decision per
        // proposal. Execution-stage decisions may repeat, because a confirm
        // that hit a version conflict is legitimately retried.
        throw new Error('duplicate proposal-stage decision');
      }
      state.decisions.push(structuredClone(row));
    },

    async findDecision(ctx, proposalId, stage) {
      calls.push(`findDecision:${stage}`);
      const row = state.decisions.find((d) => d.proposalId === proposalId && d.stage === stage);
      return row ? clone(row.decision) : null;
    },

    async findOutcome(ctx, proposalId) {
      calls.push('findOutcome');
      return clone(state.outcomesByProposal.get(String(proposalId)) ?? null);
    },

    async recordOutcome(ctx, doc, { escalation = null } = {}) {
      calls.push(`recordOutcome:${doc.outcome}`);
      // A duplicate key means another request recorded this proposal's outcome
      // first, and escalated with it if it needed escalating. Nothing more here.
      if (state.outcomesByKey.has(doc.idempotencyKey)) return insertOutcome(doc);
      if (escalation) escalate(escalation, doc.proposalId);
      return insertOutcome(doc);
    },

    async executeCancellation(ctx, { order, outcome }) {
      calls.push('executeCancellation');

      if (state.conflictNextExecute) {
        state.conflictNextExecute = false;
        throw new ConcurrentModificationError();
      }

      const existing = state.outcomesByKey.get(outcome.idempotencyKey);
      if (existing) return { outcome: clone(existing), duplicate: true };

      const stored = state.orders.get(String(order._id));
      if (!stored || stored.__v !== order.__v) throw new ConcurrentModificationError();

      // Synchronous from here: no await, so no other request can interleave
      // between the version check and the write -- the in-memory equivalent of
      // a transaction.
      const commit = () => {
        const versionBefore = stored.__v;
        stored.status = 'cancelled';
        stored.cancelledAt = new Date('2026-09-14T12:00:00Z');
        stored.__v += 1;
        return insertOutcome({
          ...outcome,
          result: {
            orderVersionBefore: versionBefore,
            orderVersionAfter: stored.__v,
            cancellationRef: `cxl-${stored.orderNumber}`,
          },
        });
      };

      if (state.failNextExecute === 'fault') {
        state.failNextExecute = null;
        throw new Error('write concern timed out');
      }
      if (state.failNextExecute === 'ambiguous-commit') {
        state.failNextExecute = null;
        commit();
        throw new Error('connection reset after the server applied the write');
      }

      return commit();
    },
  };

  return repo;
}
