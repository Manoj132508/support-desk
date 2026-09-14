import mongoose from 'mongoose';
import * as defaultModels from '../db/models/index.js';
import { policyScopeFilter, tenantFilter } from '../db/tenantScope.js';
import { RuleConflictError } from './policyAdmin.js';

/**
 * Policy administration's repository, backed by MongoDB.
 *
 * Two guarantees live here:
 *
 *   1. A NEW VERSION AND THE RETIREMENT OF THE OLD ONE HAPPEN TOGETHER. In one
 *      transaction, the previous active version is switched off and the next one
 *      is inserted. Outside a transaction there would be a moment with two
 *      active versions of the same rule, or none -- and the engine evaluates
 *      whatever is active at that moment.
 *
 *   2. TWO EDITORS CANNOT BOTH WRITE THE NEXT VERSION. The unique index on
 *      (tenantId, ruleKey, version) settles it; the loser's duplicate-key error
 *      becomes a RuleConflictError, which the service reports as "reload before
 *      editing".
 *
 * The policy-scope query -- tenant rules plus the platform baseline -- is ADR
 * 0008's deliberate cross-tenant READ, used here only to list rules and to look
 * one up by id so a baseline rule can be refused honestly. Every write uses the
 * ordinary tenant filter.
 */

const DUPLICATE_KEY = 11000;

/**
 * The only update this repository ever makes to an existing rule row.
 *
 * Versions are immutable in CONTENT (Phase 3 §5.3); `active` is bookkeeping.
 * A function returning a fresh object rather than a shared constant, because
 * Mongoose casts update documents and a frozen one would throw.
 */
export function deactivateUpdate() {
  return { $set: { active: false } };
}

export function makeMongoPolicyRepo({
  models = defaultModels,
  startSession = () => mongoose.startSession(),
  isValidId = (id) => mongoose.isValidObjectId(id),
} = {}) {
  const { PolicyRule } = models;

  return {
    async listRules(ctx) {
      return PolicyRule.find(policyScopeFilter(ctx, {})).lean();
    },

    async findRuleById(ctx, id) {
      // An id that is not an ObjectId would throw a CastError -- a 500 whose
      // body differs from a 404's. Answered as "not found" without a query.
      if (!isValidId(id)) return null;
      return PolicyRule.findOne(policyScopeFilter(ctx, { _id: id })).lean();
    },

    async findLatestVersion(ctx, ruleKey) {
      // Tenant filter, not policy scope: only a tenant's own rules have versions
      // it can write, and a baseline rule sharing the key must not be mistaken
      // for the tenant's latest.
      return PolicyRule.findOne(tenantFilter(ctx, { ruleKey })).sort({ version: -1 }).lean();
    },

    async insertVersion(ctx, { next }) {
      const session = await startSession();
      let inserted;
      try {
        await session.withTransaction(async () => {
          await PolicyRule.updateMany(
            tenantFilter(ctx, { ruleKey: next.ruleKey, active: true }),
            deactivateUpdate(),
            { session },
          );
          const [doc] = await PolicyRule.create([tenantFilter(ctx, next)], { session });
          inserted = doc.toObject();
        });
        return inserted;
      } catch (error) {
        if (error?.code === DUPLICATE_KEY) throw new RuleConflictError();
        throw error;
      } finally {
        await session.endSession();
      }
    },

    async insertRule(ctx, definition) {
      try {
        const [doc] = await PolicyRule.create([tenantFilter(ctx, definition)]);
        return doc.toObject();
      } catch (error) {
        if (error?.code === DUPLICATE_KEY) throw new RuleConflictError();
        throw error;
      }
    },
  };
}
