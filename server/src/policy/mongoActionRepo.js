import mongoose from 'mongoose';
import * as defaultModels from '../db/models/index.js';
import { policyScopeFilter, tenantFilter } from '../db/tenantScope.js';
import { makeMongoTicketRepo } from '../tickets/mongoTicketRepo.js';
import { ConcurrentModificationError } from './actionService.js';

/**
 * The action service's repository, backed by MongoDB.
 *
 * The service owns SEQUENCING; this module owns the four database guarantees
 * the sequencing depends on, and nothing else:
 *
 *   1. TENANCY in every query (ADR 0005) -- via tenantFilter, never by hand.
 *   2. ONCE-ONLY outcomes -- a duplicate-key error on the idempotency key is
 *      translated into "here is the row that already exists", not an error.
 *   3. ATOMIC, CONDITIONAL execution -- the order change and the outcome row
 *      commit in one transaction, and only if the order still holds the facts
 *      the decision was made on.
 *   4. ESCALATION WITH ITS CAUSE -- when a proposal or outcome escalates, the
 *      record and the ticket commit in one transaction (ADR 0010).
 *
 * Models and the session factory are injectable, for the same reason as
 * everywhere else in this codebase: the conditions on these queries are the
 * security-relevant part, and they can be asserted without a database.
 */

const DUPLICATE_KEY = 11000;

/** A race one retry can settle: see mongoTicketRepo.js. */
const lostRace = (error) => error?.code === DUPLICATE_KEY || error instanceof ConcurrentModificationError;

/**
 * The filter a cancellation write is conditional on.
 *
 * NOT JUST THE VERSION. `__v` catches any change made through a Mongoose
 * `save()`, but not a change made by another writer with a plain `updateOne`
 * that never touches the version -- a shipping integration marking an order
 * dispatched, for instance. A version-only guard would then let the
 * cancellation through on an order that has already shipped.
 *
 * So the write is also conditional on the fields the policy decision actually
 * read. If any of them changed after the execution-time re-check, the write
 * matches nothing, the transaction aborts, and the service reports a conflict
 * rather than acting on facts that are no longer true.
 *
 * Known limit, stated: `customer.orderCount90d` is derived from OTHER orders and
 * cannot be guarded by a condition on this one. A rule based on it could, in a
 * narrow race, decide on a count that changed a moment later.
 */
export function conditionalCancelFilter(ctx, order) {
  return tenantFilter(ctx, {
    _id: order._id,
    __v: order.__v,
    status: order.status,
    totalMinor: order.totalMinor,
    currency: order.currency,
  });
}

export function makeMongoActionRepo({
  models = defaultModels,
  startSession = () => mongoose.startSession(),
  isValidId = (id) => mongoose.isValidObjectId(id),
  tickets = makeMongoTicketRepo({ models, startSession, isValidId }),
} = {}) {
  const { Order, PolicyRule, ActionProposal, ActionOutcome, PolicyDecision } = models;

  async function findOutcomeByKey(ctx, idempotencyKey, session) {
    const query = ActionOutcome.findOne(tenantFilter(ctx, { idempotencyKey }));
    return (session ? query.session(session) : query).lean();
  }

  async function inTransaction(work) {
    const session = await startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  return {
    /** The one deliberate cross-tenant read: tenant rules plus the platform
     *  baseline (ADR 0008). Read-only, and named as the exception it is. */
    async loadRules(ctx, actionType) {
      return PolicyRule.find(policyScopeFilter(ctx, { actionType, active: true })).lean();
    },

    async countRecentOrders(ctx, customerId, since) {
      return Order.countDocuments(tenantFilter(ctx, { customerId, placedAt: { $gte: since } }));
    },

    async findCustomerOrder(ctx, customerId, orderNumber) {
      // Scoped to tenant AND customer. Another customer's order number returns
      // null exactly as a nonexistent one does, so the model cannot widen its
      // own scope by naming a different order.
      return Order.findOne(tenantFilter(ctx, { customerId, orderNumber })).lean();
    },

    async findOrderById(ctx, customerId, orderId) {
      return Order.findOne(tenantFilter(ctx, { _id: orderId, customerId })).lean();
    },

    /**
     * Insert a proposal. With an `escalation`, the proposal row and the ticket
     * write share one transaction: a proposal nobody could evaluate reaches a
     * person, or neither is written (ADR 0010).
     */
    async recordProposal(ctx, doc, { escalation = null } = {}) {
      if (!escalation) {
        const [proposal] = await ActionProposal.create([tenantFilter(ctx, doc)]);
        return proposal.toObject();
      }

      const write = () =>
        inTransaction(async (session) => {
          const [proposal] = await ActionProposal.create([tenantFilter(ctx, doc)], { session });
          await tickets.applyEscalation(ctx, { ...escalation, proposalId: proposal._id }, session);
          return proposal.toObject();
        });

      try {
        return await write();
      } catch (error) {
        // Another escalation of this conversation created or moved its ticket
        // first. The aborted transaction wrote nothing, so the whole write is
        // simply tried again, this time finding that ticket.
        if (!lostRace(error)) throw error;
        return write();
      }
    },

    async findProposal(ctx, customerId, proposalId) {
      // An id that is not a valid ObjectId would throw a CastError -- a 500
      // whose message differs from a 404's, which is an existence oracle. It is
      // answered as "no such proposal" without querying at all.
      if (!isValidId(proposalId)) return null;
      return ActionProposal.findOne(tenantFilter(ctx, { _id: proposalId, customerId })).lean();
    },

    async recordDecision(ctx, row) {
      await PolicyDecision.create([tenantFilter(ctx, row)]);
    },

    async findDecision(ctx, proposalId, stage) {
      const row = await PolicyDecision.findOne(tenantFilter(ctx, { proposalId, stage })).lean();
      return row ? row.decision : null;
    },

    async findOutcome(ctx, proposalId) {
      return ActionOutcome.findOne(tenantFilter(ctx, { proposalId })).lean();
    },

    /**
     * Insert, or return the row that already holds the idempotency key.
     *
     * The unique index is the enforcement; this is only the translation. An
     * application-level "have I seen this key?" check before inserting would be
     * a cache in front of the index, never a substitute for it -- two requests
     * can both see "no" and both insert, and only the index settles that.
     *
     * With an `escalation`, the outcome and the ticket write share one
     * transaction, so no outcome that escalates exists without its ticket.
     */
    async recordOutcome(ctx, doc, { escalation = null } = {}) {
      if (!escalation) {
        try {
          const [outcome] = await ActionOutcome.create([tenantFilter(ctx, doc)]);
          return { outcome: outcome.toObject(), duplicate: false };
        } catch (error) {
          if (error?.code !== DUPLICATE_KEY) throw error;
          const existing = await findOutcomeByKey(ctx, doc.idempotencyKey);
          if (!existing) throw error;
          return { outcome: existing, duplicate: true };
        }
      }

      const write = () =>
        inTransaction(async (session) => {
          const [outcome] = await ActionOutcome.create([tenantFilter(ctx, doc)], { session });
          await tickets.applyEscalation(ctx, { ...escalation, proposalId: doc.proposalId }, session);
          return { outcome: outcome.toObject(), duplicate: false };
        });

      try {
        return await write();
      } catch (error) {
        if (!lostRace(error)) throw error;

        // Looked up OUTSIDE the aborted transaction, whose snapshot could not
        // see a winner's commit. If the key is held, another request recorded
        // this proposal's outcome first -- and escalated with it, if it needed
        // escalating. Its row is the answer.
        const existing = await findOutcomeByKey(ctx, doc.idempotencyKey);
        if (existing) return { outcome: existing, duplicate: true };

        // Otherwise the race lost was over the conversation's ticket. Once
        // more, now that there is a ticket to append to.
        return write();
      }
    },

    /**
     * The only write in the system that changes business data.
     *
     * Inside one transaction: check whether this proposal already has an
     * outcome, apply the conditional cancellation, insert the `executed` row.
     * Either all three hold or none do, which is what makes "the order was
     * cancelled but no audit record exists" impossible rather than unlikely.
     *
     * `withTransaction` retries on transient errors, so the callback is written
     * to be safely re-run: it re-reads rather than trusting anything from a
     * previous attempt.
     */
    async executeCancellation(ctx, { order, outcome }) {
      const session = await startSession();
      let result;

      try {
        await session.withTransaction(async () => {
          result = undefined;

          const existing = await findOutcomeByKey(ctx, outcome.idempotencyKey, session);
          if (existing) {
            result = { outcome: existing, duplicate: true };
            return;
          }

          const cancellationRef = `cxl-${String(order._id)}`;
          const updated = await Order.findOneAndUpdate(
            conditionalCancelFilter(ctx, order),
            {
              $set: {
                status: 'cancelled',
                cancelledAt: outcome.confirmation?.at ?? new Date(),
                cancellationRef,
              },
              $inc: { __v: 1 },
            },
            { new: true, session },
          ).lean();

          if (!updated) throw new ConcurrentModificationError();

          const [created] = await ActionOutcome.create(
            [
              tenantFilter(ctx, {
                ...outcome,
                result: {
                  orderVersionBefore: order.__v,
                  orderVersionAfter: updated.__v,
                  cancellationRef,
                },
              }),
            ],
            { session },
          );
          result = { outcome: created.toObject(), duplicate: false };
        });
      } catch (error) {
        if (!(error instanceof ConcurrentModificationError)) throw error;

        /*
         * A conflict can mean the order genuinely changed -- or that ANOTHER
         * confirmation of this same proposal committed first and bumped the
         * version. The transaction's snapshot predates that commit, so it could
         * not see the winner's outcome row. Looking again, outside the aborted
         * snapshot, tells the two apart: if the key is now held, this was a
         * duplicate confirmation and the original result is the answer.
         */
        const winner = await findOutcomeByKey(ctx, outcome.idempotencyKey);
        if (winner) return { outcome: winner, duplicate: true };
        throw error;
      } finally {
        await session.endSession();
      }

      return result;
    },
  };
}
