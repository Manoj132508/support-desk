import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/**
 * The mutable half of the schema: tenants, identities, business records and
 * conversation content. The append-only audit spine lives in `audit.js`.
 *
 * Conventions used throughout, each with a reason:
 *
 * - `tenantId` leads every compound index. ADR 0005 puts tenancy in the query,
 *   so it is in every filter, so it belongs first in every index -- that is
 *   what makes the correct thing also the fast thing.
 * - Money is `Int32` MINOR UNITS with the currency beside it. Never a float:
 *   `order.totalMinor` is a policy condition operand, and a float comparison
 *   that varies across platforms would make the one component whose
 *   determinism the whole project rests on non-deterministic.
 * - `timestamps: true` everywhere except immutable collections, which record
 *   their own single `createdAt`.
 */

const money = {
  type: Number,
  required: true,
  min: 0,
  validate: {
    validator: Number.isInteger,
    message: '{PATH} must be an integer number of minor units, never a float',
  },
};

/* ── Tenant ───────────────────────────────────────────────────────────────
 * Not in the Phase 1 entity list. Added in Phase 3: tenancy needs something
 * to be a tenant OF, and both staff and customers belong to one. */
const tenantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  },
  { timestamps: true },
);

/* ── User — authentication for all four roles ───────────────────────────── */
export const ROLES = ['customer', 'agent', 'lead', 'admin'];

const userSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    /**
     * `select: false` — excluded from every query unless asked for explicitly.
     *
     * The default is the protection. Without it, every `findOne` in the system
     * carries a password hash it does not need, and one careless `res.json(user)`
     * puts it on the wire. Login opts in with `.select('+passwordHash')`; nothing
     * else does.
     */
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, trim: true },
    role: { type: String, enum: ROLES, required: true },
    // Set only for role 'customer'. The split between authentication and the
    // commerce subject is what lets a deletion remove credentials while audit
    // rows keep pointing at a Customer id that no longer resolves to a person.
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  },
  { timestamps: true },
);
userSchema.index({ tenantId: 1, email: 1 }, { unique: true });

/* ── Customer — the commerce subject ────────────────────────────────────── */
const customerSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    externalRef: { type: String, default: null, trim: true },
    displayName: { type: String, default: null, trim: true },
    email: { type: String, default: null, lowercase: true, trim: true },
    /**
     * Deletion scrubs this document in place and leaves the `_id`. Audit rows
     * then point at an id that resolves to a profile containing no personal
     * data -- the decision structure survives, the person does not, and no
     * immutable row is ever rewritten (ADR 0006 amendment).
     */
    deidentifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
customerSchema.index({ tenantId: 1, externalRef: 1 });

/* ── Order — seeded demo records ────────────────────────────────────────── */
export const ORDER_STATUS = [
  'placed',
  'paid',
  'packed',
  'dispatched',
  'delivered',
  'cancelled',
];

const orderSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    orderNumber: { type: String, required: true, trim: true },
    status: { type: String, enum: ORDER_STATUS, required: true, default: 'placed' },
    items: [
      {
        _id: false,
        sku: { type: String, required: true },
        name: { type: String, required: true },
        qty: { type: Number, required: true, min: 1 },
        unitPriceMinor: money,
      },
    ],
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
    totalMinor: money,
    placedAt: { type: Date, required: true },
    dispatchedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationRef: { type: String, default: null },
  },
  {
    timestamps: true,
    // Mongoose's __v as an optimistic-concurrency token. Execution reads the
    // version and makes the cancelling update conditional on it, which closes
    // the gap between DECIDING and WRITING -- the companion to ADR 0003's
    // re-check, which closes the gap between PROPOSING and deciding.
    optimisticConcurrency: true,
  },
);
orderSchema.index({ tenantId: 1, orderNumber: 1 }, { unique: true });
orderSchema.index({ tenantId: 1, customerId: 1, placedAt: -1 });

/** Derived at evaluation, never stored, so a rule cannot be decided against a
 *  stale age (Phase 3 section 9). */
orderSchema.methods.ageHours = function ageHours(now = new Date()) {
  return (now.getTime() - this.placedAt.getTime()) / 3_600_000;
};

/* ── Conversation and Message ───────────────────────────────────────────── */
const conversationSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    channel: { type: String, enum: ['web'], default: 'web' },
    status: { type: String, enum: ['active', 'escalated', 'closed'], default: 'active' },
    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);
conversationSchema.index({ tenantId: 1, customerId: 1, lastMessageAt: -1 });

const messageSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    role: { type: String, enum: ['customer', 'assistant', 'agent', 'system'], required: true },
    content: { type: String, default: '' },
    // A turn is written ONCE, when it finishes -- complete or cancelled. That
    // avoids updating a row as tokens stream, which would mean the transcript
    // is mutable for the duration of every response.
    state: { type: String, enum: ['complete', 'cancelled'], default: 'complete' },
    evidence: [
      {
        _id: false,
        kind: { type: String, enum: ['kb_chunk', 'tool_result'], required: true },
        ref: { type: String, required: true },
      },
    ],
    proposalId: { type: Schema.Types.ObjectId, ref: 'ActionProposal', default: null },
    correlationId: { type: String, default: null },
  },
  { timestamps: true },
);
messageSchema.index({ tenantId: 1, conversationId: 1, createdAt: 1 });

/* ── Ticket ─────────────────────────────────────────────────────────────── */
const ticketSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    /** Denormalised cache of the TicketEvent stream. Rebuildable, and a test
     *  rebuilds it (ADR 0006). The events remain the source of truth. */
    currentStatus: {
      type: String,
      enum: ['open', 'assigned', 'waiting', 'resolved', 'closed'],
      required: true,
      default: 'open',
    },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, default: null },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    /**
     * Agent-authored free text lives HERE, on the mutable ticket, and never in
     * the immutable TicketEvent. That keeps free text out of rows that can
     * never be scrubbed -- the same constraint that keeps snippets out of
     * ActionProposal.evidence (Phase 3 section 7).
     */
    note: { type: String, default: null },
    openedAt: { type: Date, default: Date.now },
    closedAt: { type: Date, default: null },
    /**
     * True until the ticket is closed. A conversation has at most ONE active
     * ticket (FR-8.3, ADR 0010), and the partial unique index below is what
     * enforces it: two escalations racing to create a conversation's first
     * ticket cannot both succeed, whatever each of them read beforehand.
     */
    active: { type: Boolean, required: true, default: true },
    /**
     * The seq of this ticket's latest TicketEvent. Every write to the ticket
     * increments it in the same update and the event takes the new value, so
     * two writers can never choose the same seq by each reading the last event.
     */
    lastEventSeq: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);
// The queue sorts on (openedAt, _id), _id breaking ties for its keyset cursor,
// so both queue indexes end in both fields. Ending at openedAt, the planner
// still chose them and then sorted every matching ticket in memory (Phase 14,
// perf/queryPlans.js). One status, oldest first:
ticketSchema.index({ tenantId: 1, currentStatus: 1, openedAt: 1, _id: 1 });
// The default queue: every ticket still being worked, oldest first.
ticketSchema.index({ tenantId: 1, active: 1, openedAt: 1, _id: 1 });
ticketSchema.index(
  { tenantId: 1, conversationId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

export const Tenant = model('Tenant', tenantSchema);
export const User = model('User', userSchema);
export const Customer = model('Customer', customerSchema);
export const Order = model('Order', orderSchema);
export const Conversation = model('Conversation', conversationSchema);
export const Message = model('Message', messageSchema);
export const Ticket = model('Ticket', ticketSchema);
