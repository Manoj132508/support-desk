import mongoose from 'mongoose';
import * as defaultModels from '../db/models/index.js';
import { tenantFilter } from '../db/tenantScope.js';
import { AppError } from '../errors/AppError.js';

/**
 * Account deletion's repository. See accountDeletion.js for WHAT is removed and
 * why; this module guarantees HOW:
 *
 *   1. ONE TRANSACTION. Every delete and every scrub commits together or not at
 *      all.
 *   2. SCOPED TO THE TENANT AND THE CUSTOMER in every filter, by tenantFilter.
 *   3. NO AUDIT COLLECTION IS TOUCHED. The models used are listed below, and
 *      none of them is append-only -- which is not luck but the design: the
 *      audit spine holds no free text, so deletion never needs to reach it.
 */

export function makeMongoAccountRepo({ models = defaultModels, startSession = () => mongoose.startSession() } = {}) {
  const { User, Customer, Conversation, Message, Ticket } = models;

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
    /** The one read of a password hash outside login, for the user being deleted. */
    async findUserWithHash(ctx, userId) {
      return User.findOne(tenantFilter(ctx, { _id: userId })).select('+passwordHash').lean();
    },

    async deidentifyCustomer(ctx, { userId, customerId, now }) {
      return inTransaction(async (session) => {
        const conversations = await Conversation.find(tenantFilter(ctx, { customerId }))
          .select('_id')
          .session(session)
          .lean();
        const conversationIds = conversations.map((conversation) => conversation._id);

        const messages =
          conversationIds.length > 0
            ? await Message.deleteMany(tenantFilter(ctx, { conversationId: { $in: conversationIds } }), { session })
            : { deletedCount: 0 };

        const deletedConversations = await Conversation.deleteMany(tenantFilter(ctx, { customerId }), { session });

        // Retained and scrubbed, not deleted (Phase 7): a ticket anchors its
        // immutable events. The agent's note is its only free text.
        const tickets = await Ticket.updateMany(tenantFilter(ctx, { customerId }), { $set: { note: null } }, { session });

        await Customer.updateOne(
          tenantFilter(ctx, { _id: customerId }),
          { $set: { displayName: null, email: null, externalRef: null, deidentifiedAt: now } },
          { session },
        );

        const users = await User.deleteOne(tenantFilter(ctx, { _id: userId, customerId }), { session });
        if (users.deletedCount !== 1) {
          // Already gone -- another request deleted it first. Abort, so this
          // attempt writes nothing of its own.
          throw AppError.notFound();
        }

        return {
          messages: messages.deletedCount,
          conversations: deletedConversations.deletedCount,
          ticketsScrubbed: tickets.modifiedCount,
        };
      });
    },
  };
}
