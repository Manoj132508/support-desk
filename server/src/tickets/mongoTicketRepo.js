import mongoose from 'mongoose';
import * as defaultModels from '../db/models/index.js';
import { policyScopeFilter, tenantFilter } from '../db/tenantScope.js';
import { planTransition, TICKET_STATUS } from '../domain/ticketState.js';
import { ConcurrentModificationError } from '../policy/actionService.js';
import { planEscalation } from './escalation.js';

/**
 * Tickets and their events, backed by MongoDB. FR-8, FR-9.
 *
 * Three guarantees live here:
 *
 *   1. AN ESCALATION COMMITS WITH WHATEVER CAUSED IT. `applyEscalation` never
 *      opens a transaction of its own; it runs inside the caller's. The action
 *      repository calls it in the same transaction as the outcome it records,
 *      so no audit row says "escalated" without a ticket behind it (ADR 0010).
 *
 *   2. ONE ACTIVE TICKET PER CONVERSATION. The partial unique index settles a
 *      race between two first escalations. The loser retries once, finds the
 *      winner's ticket, and appends to it.
 *
 *   3. EVERY TICKET WRITE IS CONDITIONAL AND COUNTED. A write applies only if
 *      the ticket is still in the state it was planned from, and it increments
 *      `lastEventSeq` in the same update. The event takes that value, so two
 *      writers can never pick the same seq.
 *
 * Models, sessions and the clock are injectable, as in the other repositories:
 * the conditions on these writes are the part worth asserting, and they can be
 * asserted without a database.
 */

const DUPLICATE_KEY = 11000;
const REFUSED_OUTCOMES = ['refused_at_proposal', 'refused_at_execution'];

/** A lost race that one retry can settle: another writer created the
 *  conversation's ticket, or moved it, between this writer's read and write. */
const lostRace = (error) => error?.code === DUPLICATE_KEY || error instanceof ConcurrentModificationError;

export function makeMongoTicketRepo({
  models = defaultModels,
  startSession = () => mongoose.startSession(),
  isValidId = (id) => mongoose.isValidObjectId(id),
  clock = () => new Date(),
} = {}) {
  const { Ticket, TicketEvent, Conversation, Message, ActionProposal, ActionOutcome, PolicyDecision, PolicyRule } =
    models;

  async function inTransaction(work) {
    const session = await startSession();
    let result;
    try {
      // withTransaction re-runs the callback on transient errors, so `work`
      // re-reads everything it depends on rather than trusting an earlier run.
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async function appendEvent(ctx, ticket, event, correlationId, session) {
    await TicketEvent.create(
      [tenantFilter(ctx, { ...event, ticketId: ticket._id, seq: ticket.lastEventSeq, correlationId })],
      { session },
    );
  }

  /**
   * Create or update the conversation's ticket, inside the CALLER's session.
   * FR-8.3. See `planEscalation` for what each case writes.
   */
  async function applyEscalation(ctx, escalation, session) {
    const { conversationId, customerId, reason, actor, proposalId = null, correlationId = null } = escalation;

    const activeTicket = await Ticket.findOne(tenantFilter(ctx, { conversationId, active: true }))
      .session(session)
      .lean();
    const plan = planEscalation({ activeTicket, reason, actor, proposalId });

    let ticket;
    if (plan.kind === 'create') {
      const [created] = await Ticket.create(
        [tenantFilter(ctx, { ...plan.ticket, conversationId, customerId })],
        { session },
      );
      ticket = created.toObject();
    } else {
      const update = { $inc: { lastEventSeq: 1 } };
      if (plan.toStatus) update.$set = { currentStatus: plan.toStatus };
      ticket = await Ticket.findOneAndUpdate(
        tenantFilter(ctx, { _id: plan.ticketId, active: true, currentStatus: plan.expectedStatus }),
        update,
        { new: true, session },
      ).lean();
      if (!ticket) throw new ConcurrentModificationError('The ticket changed while it was being escalated');
    }

    await appendEvent(ctx, ticket, plan.event, correlationId, session);

    // The conversation points at its current ticket, so the console can reach
    // the ticket from the conversation without searching for it.
    await Conversation.updateOne(
      tenantFilter(ctx, { _id: conversationId }),
      { $set: { status: 'escalated', ticketId: ticket._id } },
      { session },
    );

    return { ticketId: ticket._id, status: ticket.currentStatus, created: plan.kind === 'create' };
  }

  return {
    applyEscalation,

    /** An escalation with no other record to commit with -- a customer asking
     *  for a person -- in its own transaction. */
    async escalate(ctx, escalation) {
      try {
        return await inTransaction((session) => applyEscalation(ctx, escalation, session));
      } catch (error) {
        if (!lostRace(error)) throw error;
        return inTransaction((session) => applyEscalation(ctx, escalation, session));
      }
    },

    /**
     * A manual transition. Returns null for a ticket that does not exist in
     * this tenant. NOT retried on a lost race: if another agent moved the
     * ticket first, this agent needs to see where it is now, not have a move
     * planned from a state that no longer holds applied anyway.
     */
    async transition(ctx, { ticketId, to, actor, correlationId = null }) {
      if (!isValidId(ticketId)) return null;

      return inTransaction(async (session) => {
        const ticket = await Ticket.findOne(tenantFilter(ctx, { _id: ticketId })).session(session).lean();
        if (!ticket) return null;

        const plan = planTransition({ ticket, to, actor, now: clock() });
        const updated = await Ticket.findOneAndUpdate(
          tenantFilter(ctx, { _id: ticket._id, currentStatus: plan.expectedStatus }),
          { $set: plan.set, $inc: { lastEventSeq: 1 } },
          { new: true, session },
        ).lean();
        if (!updated) throw new ConcurrentModificationError('The ticket changed while it was being updated');

        await appendEvent(ctx, updated, plan.event, correlationId, session);
        return updated;
      });
    },

    /** The queue (FR-10.1): every active ticket by default, or one status, oldest
     *  first. One extra row is read so the caller knows whether a next page exists. */
    async listTickets(ctx, { status = null, after = null, limit }) {
      const filter = tenantFilter(ctx, status ? { currentStatus: status } : { active: true });
      if (after) {
        filter.$or = [
          { openedAt: { $gt: after.openedAt } },
          { openedAt: after.openedAt, _id: { $gt: after.id } },
        ];
      }
      return Ticket.find(filter).sort({ openedAt: 1, _id: 1 }).limit(limit + 1).lean();
    },

    async countByStatus(ctx) {
      const entries = await Promise.all(
        Object.values(TICKET_STATUS).map(async (status) => [
          status,
          await Ticket.countDocuments(tenantFilter(ctx, { currentStatus: status })),
        ]),
      );
      return Object.fromEntries(entries);
    },

    async findTicket(ctx, ticketId) {
      // An id that is not an ObjectId would throw a CastError -- a 500 whose
      // body differs from a 404's. Answered as "not found" without a query.
      if (!isValidId(ticketId)) return null;
      return Ticket.findOne(tenantFilter(ctx, { _id: ticketId })).lean();
    },

    async listEvents(ctx, ticketId) {
      return TicketEvent.find(tenantFilter(ctx, { ticketId })).sort({ seq: 1 }).lean();
    },

    async findConversation(ctx, conversationId) {
      return Conversation.findOne(tenantFilter(ctx, { _id: conversationId })).lean();
    },

    async findCustomerConversation(ctx, customerId, conversationId) {
      if (!isValidId(conversationId)) return null;
      return Conversation.findOne(tenantFilter(ctx, { _id: conversationId, customerId })).lean();
    },

    async listMessages(ctx, conversationId) {
      return Message.find(tenantFilter(ctx, { conversationId })).sort({ createdAt: 1 }).lean();
    },

    /** Every action the assistant attempted in a conversation, with its outcome
     *  and each policy decision -- the console's blocked-actions panel (FR-10.3). */
    async listAttempts(ctx, conversationId) {
      const proposals = await ActionProposal.find(tenantFilter(ctx, { conversationId }))
        .sort({ createdAt: 1 })
        .lean();
      if (proposals.length === 0) return [];

      const ids = proposals.map((proposal) => proposal._id);
      const [outcomes, decisions] = await Promise.all([
        ActionOutcome.find(tenantFilter(ctx, { proposalId: { $in: ids } })).lean(),
        PolicyDecision.find(tenantFilter(ctx, { proposalId: { $in: ids } })).sort({ createdAt: 1 }).lean(),
      ]);

      const sameProposal = (proposal) => (row) => String(row.proposalId) === String(proposal._id);
      return proposals.map((proposal) => ({
        proposal,
        outcome: outcomes.find(sameProposal(proposal)) ?? null,
        decisions: decisions.filter(sameProposal(proposal)),
      }));
    },

    /**
     * The rule versions that decided a conversation's attempts, for their
     * internal reason (ADR 0007: the console shows both channels).
     *
     * POLICY SCOPE, deliberately -- the one cross-tenant read ADR 0008 allows,
     * because a baseline rule belongs to no tenant. Read-only, like every other
     * use of that filter.
     */
    async findRules(ctx, ruleIds) {
      const ids = ruleIds.filter((id) => isValidId(id));
      if (ids.length === 0) return [];
      return PolicyRule.find(policyScopeFilter(ctx, { _id: { $in: ids } })).lean();
    },

    /**
     * ADR 0010: an accepted offer is recorded as `policy_refused` only when the
     * server can see the refusal itself. Scoped to tenant, customer AND
     * conversation, so a proposal id from anywhere else finds nothing -- exactly
     * as a proposal id that does not exist.
     */
    async findRefusedProposal(ctx, { customerId, conversationId, proposalId }) {
      if (!isValidId(proposalId)) return null;
      const proposal = await ActionProposal.findOne(
        tenantFilter(ctx, { _id: proposalId, customerId, conversationId }),
      ).lean();
      if (!proposal) return null;
      const refusal = await ActionOutcome.findOne(
        tenantFilter(ctx, { proposalId: proposal._id, outcome: { $in: REFUSED_OUTCOMES } }),
      ).lean();
      return refusal ? proposal : null;
    },
  };
}
