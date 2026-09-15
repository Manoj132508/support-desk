import mongoose from 'mongoose';
import { AppError } from '../errors/AppError.js';

/**
 * Tenancy applied in the query, never after it. INV-D, ADR 0005.
 *
 * The mistake this exists to make impossible:
 *
 *     const order = await Order.findById(id);           // already wrong
 *     if (order.tenantId !== user.tenantId) throw 403;  // forgettable, and it leaks
 *
 * Two defects. The check is optional, so one new route that forgets is a
 * silent cross-tenant read. And a 403 CONFIRMS THE RECORD EXISTS, so an
 * attacker enumerating ids learns which are real from the status code alone.
 *
 * `scoped(Model, ctx)` returns a narrow surface where the tenant filter is not
 * something you remember to add -- it is the only way to build a query. There
 * is no code path here that loads a foreign record and then decides what to do
 * with it, because the record is never fetched.
 *
 * `orNotFound` throws the argument-free 404 from Phase 6, which is
 * byte-identical whether the record is absent or another tenant's.
 */

function requireTenant(ctx) {
  const tenantId = ctx?.tenantId;
  if (!tenantId) {
    // A missing tenant is a programming error, not a user error. Failing loudly
    // is the point: the alternative is a query with `tenantId: undefined`,
    // which in Mongo matches documents where the field is absent and is
    // therefore a silent cross-tenant read.
    throw AppError.fault('tenantScope called without a tenant context');
  }
  return tenantId;
}

export function tenantFilter(ctx, extra = {}) {
  return { ...extra, tenantId: requireTenant(ctx) };
}

export function scoped(Model, ctx) {
  const tenantId = requireTenant(ctx);
  const withTenant = (filter = {}) => ({ ...filter, tenantId });

  /*
   * An id that cannot be an ObjectId is answered as "no such record" BEFORE
   * any query. Left to Mongoose it becomes a CastError: a 500 whose message
   * names the model and echoes the input, where every other miss is a plain 404
   * (Phase 12). `{ $in: [] }` matches nothing, so `findById` keeps returning a
   * query that resolves to null.
   */
  const idFilter = (id) => (mongoose.isValidObjectId(id) ? { _id: id } : { _id: { $in: [] } });

  return {
    find: (filter, options) => Model.find(withTenant(filter), null, options),
    findOne: (filter, options) => Model.findOne(withTenant(filter), null, options),
    findById: (id, options) => Model.findOne(withTenant(idFilter(id)), null, options),
    countDocuments: (filter) => Model.countDocuments(withTenant(filter)),

    /** The common case: fetch one, and treat absent and foreign identically. */
    async findByIdOrNotFound(id, options) {
      if (!mongoose.isValidObjectId(id)) throw AppError.notFound();
      const doc = await Model.findOne(withTenant({ _id: id }), null, options);
      if (!doc) throw AppError.notFound();
      return doc;
    },

    async findOneOrNotFound(filter, options) {
      const doc = await Model.findOne(withTenant(filter), null, options);
      if (!doc) throw AppError.notFound();
      return doc;
    },

    /** Inserts carry the tenant too, so a record cannot be created unscoped. */
    create: (doc, options) => Model.create([{ ...doc, tenantId }], options ?? {}),
  };
}

/**
 * THE ONE DELIBERATE EXCEPTION (ADR 0008).
 *
 * Policy evaluation loads the caller's tenant rules PLUS the platform baseline,
 * which is stored with `tenantId: null`. That is the only query in the system
 * that intentionally reaches outside the caller's tenant.
 *
 * It is read-only, it is confined to this one function, and it is named so it
 * reads as a decision rather than as the oversight it would otherwise look
 * like to anyone grepping for tenancy violations. A test asserts nothing else
 * builds a `$in` over tenantId.
 */
export function policyScopeFilter(ctx, extra = {}) {
  return { ...extra, tenantId: { $in: [requireTenant(ctx), null] } };
}
