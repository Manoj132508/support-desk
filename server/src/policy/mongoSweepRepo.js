import mongoose from 'mongoose';
import * as defaultModels from '../db/models/index.js';
import { makeMongoActionRepo } from './mongoActionRepo.js';

/**
 * The expiry sweep's repository, backed by MongoDB.
 *
 * Two methods of its own, and two borrowed from the action repository, so that
 * "find the proposal-time decision" and "record an outcome, or return the one
 * already holding the idempotency key" have exactly one implementation each.
 * The sweep and a customer's confirmation therefore race on the same unique
 * index, which is what makes that race safe.
 *
 * Listing tenants is the only unscoped read, and it is unscoped by nature: the
 * Tenant collection is the list of scopes, not data inside one. Every business
 * read and write happens within a single tenant (see expirySweep.js).
 */

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

/**
 * Pending = resolved, older than the cutoff, and holding no outcome row.
 *
 * A pure function for the same reason as the audit pipeline: the stages that
 * matter can be asserted without a database. The same trap applies too --
 * `aggregate()` does not cast ids the way `find()` does, so the tenant is
 * converted explicitly, and repeated inside the join.
 *
 * Oldest first: the longest-forgotten dialogs expire first, so a bounded batch
 * always makes progress on the backlog rather than circling the newest rows.
 */
export function pendingProposalsPipeline(ctx, { olderThan, limit }, { outcomes }) {
  if (!ctx?.tenantId) throw new Error('pendingProposalsPipeline requires a tenant context');
  const tenantId = toObjectId(ctx.tenantId);

  return [
    { $match: { tenantId, validity: 'resolved', createdAt: { $lt: olderThan } } },
    { $sort: { createdAt: 1, _id: 1 } },
    {
      $lookup: {
        from: outcomes,
        let: { proposalId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $and: [{ $eq: ['$proposalId', '$$proposalId'] }, { $eq: ['$tenantId', tenantId] }] },
            },
          },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'outcomeRows',
      },
    },
    // Filtered BEFORE the limit, so a batch is `limit` genuinely pending
    // proposals rather than `limit` rows of which some were already decided.
    { $match: { outcomeRows: { $size: 0 } } },
    { $limit: limit },
    { $project: { outcomeRows: 0 } },
  ];
}

export function makeMongoSweepRepo({ models = defaultModels, actionRepo } = {}) {
  const { Tenant, ActionProposal, ActionOutcome } = models;
  const actions = actionRepo ?? makeMongoActionRepo({ models });

  return {
    async listTenantIds() {
      const tenants = await Tenant.find({}, { _id: 1 }).lean();
      return tenants.map((tenant) => tenant._id);
    },

    async findPendingProposals(ctx, { olderThan, limit }) {
      return ActionProposal.aggregate(
        pendingProposalsPipeline(ctx, { olderThan, limit }, { outcomes: ActionOutcome.collection.name }),
      );
    },

    findDecision: (ctx, proposalId, stage) => actions.findDecision(ctx, proposalId, stage),
    recordOutcome: (ctx, doc) => actions.recordOutcome(ctx, doc),
  };
}
