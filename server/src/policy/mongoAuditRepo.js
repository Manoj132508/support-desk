import mongoose from 'mongoose';
import * as defaultModels from '../db/models/index.js';

/**
 * The audit query's repository: one aggregation over ActionProposal.
 *
 * The unit is the ATTEMPT -- every proposal, malformed or not -- with its
 * outcome and its proposal-time decision joined on where they exist. That is
 * what lets one query answer "what did the assistant try to do", including
 * attempts that never reached the policy engine.
 *
 * AN AGGREGATION DOES NOT CAST. `find()` quietly converts a string id into an
 * ObjectId; `aggregate()` does not, and a `$match` comparing an ObjectId field
 * to a string matches nothing. For the tenant filter that would fail safe --
 * an empty audit -- but it would also be a silent, baffling bug. Every id is
 * converted explicitly.
 */

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

/**
 * The pipeline, as a pure function, so its security-relevant stages can be
 * asserted without a database: the tenant match first, the tenant condition
 * INSIDE each lookup, and the keyset bound.
 *
 * Tenant conditions inside the lookups are defence in depth. A proposal's
 * outcome and decisions always share its tenant, so the join key alone would
 * be enough -- as long as that invariant is never broken by a bug elsewhere.
 * The extra condition means a broken invariant yields a missing join, never
 * another tenant's decision attached to this tenant's attempt.
 */
export function buildAttemptPipeline(
  ctx,
  { kinds = null, actionType = null, customerId = null, from = null, to = null, before = null, limit },
  { outcomes, decisions },
) {
  if (!ctx?.tenantId) throw new Error('buildAttemptPipeline requires a tenant context');
  const tenantId = toObjectId(ctx.tenantId);

  const match = { tenantId };
  if (actionType) match.actionType = actionType;
  if (customerId) match.customerId = toObjectId(customerId);
  if (from || to) {
    match.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  }
  if (before) {
    // Keyset: strictly older than the last row of the previous page, with _id
    // breaking ties between attempts written in the same millisecond.
    match.$or = [
      { createdAt: { $lt: before.createdAt } },
      { createdAt: before.createdAt, _id: { $lt: toObjectId(before.id) } },
    ];
  }

  const stages = [{ $match: match }, { $sort: { createdAt: -1, _id: -1 } }];

  // With no kind filter, the page can be cut BEFORE the joins, so only `limit`
  // attempts are joined. A kind filter depends on the joined outcome, so the
  // cut has to come after it.
  if (!kinds) stages.push({ $limit: limit });

  stages.push(
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
        ],
        as: 'outcomeRows',
      },
    },
    {
      $lookup: {
        from: decisions,
        let: { proposalId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$proposalId', '$$proposalId'] },
                  { $eq: ['$stage', 'proposal'] },
                  { $eq: ['$tenantId', tenantId] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: 'decisionRows',
      },
    },
    {
      $set: {
        outcome: { $first: '$outcomeRows' },
        proposalDecision: { $first: '$decisionRows.decision' },
      },
    },
    {
      // Must agree with kindOf() in auditQuery.js, which labels the rows this
      // stage filters. The branches are in the same order for that reason.
      $set: {
        kind: {
          $switch: {
            branches: [
              { case: { $eq: ['$validity', 'malformed'] }, then: 'malformed' },
              { case: { $ne: [{ $type: '$outcome' }, 'missing'] }, then: '$outcome.outcome' },
            ],
            default: 'pending',
          },
        },
      },
    },
  );

  if (kinds) stages.push({ $match: { kind: { $in: [...kinds] } } }, { $limit: limit });

  stages.push({ $project: { outcomeRows: 0, decisionRows: 0 } });
  return stages;
}

export function makeMongoAuditRepo({ models = defaultModels } = {}) {
  const { ActionProposal, ActionOutcome, PolicyDecision } = models;

  return {
    async findAttempts(ctx, filters) {
      const pipeline = buildAttemptPipeline(ctx, filters, {
        outcomes: ActionOutcome.collection.name,
        decisions: PolicyDecision.collection.name,
      });
      return ActionProposal.aggregate(pipeline);
    },
  };
}
