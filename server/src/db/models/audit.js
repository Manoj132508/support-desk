import mongoose from 'mongoose';
import { immutablePlugin } from '../plugins/immutable.js';

const { Schema, model } = mongoose;

/**
 * The audit spine. Three append-only collections, plus the versioned policy
 * rules that decisions point back at.
 *
 * These are the collections that make INV-A demonstrable rather than merely
 * claimed. A log of successful cancellations proves the feature works; it says
 * nothing about whether anything was ever PREVENTED. The refusals are the
 * evidence, so nothing here is ever edited or deleted (ADR 0006).
 */

/* ── PolicyRule ───────────────────────────────────────────────────────────
 *
 * Not under immutablePlugin, and the exception is deliberate: the `active`
 * flag flips when a new version supersedes an old one. Versions are immutable
 * in CONTENT; the flag is bookkeeping. A test asserts no other field ever
 * changes on an existing version. */

export const OUTCOME_LADDER = ['auto-execute', 'confirm-required', 'agent-only', 'refuse'];

/**
 * The condition vocabulary, as a registry (Phase 3 section 5.2).
 *
 * This is the policy engine's entire input contract. Keeping it closed and
 * typed is what makes `evaluate()` a total function over a small, enumerable
 * input space -- which is what makes exhaustive testing possible and the golden
 * set meaningful. A rule naming an unregistered field is rejected when it is
 * SAVED, not discovered when it is evaluated.
 */
export const CONDITION_FIELDS = {
  'order.status': {
    type: 'enum',
    operators: ['eq', 'ne', 'in', 'nin'],
    values: ['placed', 'paid', 'packed', 'dispatched', 'delivered', 'cancelled'],
  },
  'order.ageHours': { type: 'int', operators: ['lt', 'lte', 'gt', 'gte'] },
  'order.totalMinor': { type: 'int', operators: ['lt', 'lte', 'gt', 'gte'] },
  'order.currency': { type: 'enum', operators: ['eq', 'in'], values: null },
  'customer.orderCount90d': { type: 'int', operators: ['lt', 'lte', 'gt', 'gte'] },
};

const conditionSchema = new Schema(
  {
    _id: false,
    field: { type: String, required: true },
    op: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const policyRuleSchema = new Schema(
  {
    /** null ⇒ the platform baseline, which no tenant may relax (ADR 0008). */
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null },
    ruleKey: { type: String, required: true, trim: true },
    version: { type: Number, required: true, min: 1 },
    active: { type: Boolean, required: true, default: true },
    actionType: { type: String, required: true, enum: ['order.cancel'] },
    priority: { type: Number, required: true, default: 100 },
    conditions: { type: [conditionSchema], default: [] },
    outcome: { type: String, required: true, enum: OUTCOME_LADDER },
    /** ADR 0007. Required, because writing the human sentence is part of
     *  writing the rule -- not an afterthought. */
    customerMessage: { type: String, required: true, trim: true },
    internalReason: { type: String, required: true, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

policyRuleSchema.index({ tenantId: 1, ruleKey: 1, version: 1 }, { unique: true });
policyRuleSchema.index({ actionType: 1, active: 1, priority: 1 });

/**
 * Validate conditions against the registry at SAVE time.
 *
 * The alternative -- validating at evaluation -- means a bad rule sits in the
 * database looking fine until the moment it is asked to decide something, which
 * is the worst possible moment to discover it.
 */
policyRuleSchema.pre('validate', function validateConditions(next) {
  for (const condition of this.conditions ?? []) {
    const spec = CONDITION_FIELDS[condition.field];
    if (!spec) {
      return next(new Error(`Unknown condition field: ${condition.field}`));
    }
    if (!spec.operators.includes(condition.op)) {
      return next(
        new Error(
          `Operator "${condition.op}" is not permitted on ${condition.field} ` +
            `(allowed: ${spec.operators.join(', ')})`,
        ),
      );
    }
    if (spec.type === 'int') {
      const value = condition.value;
      if (!Number.isInteger(value)) {
        return next(new Error(`${condition.field} requires an integer value`));
      }
    }
    if (spec.type === 'enum' && spec.values) {
      const supplied = Array.isArray(condition.value) ? condition.value : [condition.value];
      const bad = supplied.filter((v) => !spec.values.includes(v));
      if (bad.length) {
        return next(new Error(`${condition.field} has no such value: ${bad.join(', ')}`));
      }
    }
  }
  return next();
});

/* ── ActionProposal — what the model asked for ──────────────────────────── */

/**
 * Evidence: REFERENCES ONLY, never snippets.
 *
 * A copied-in KB excerpt or customer sentence would be free text inside a row
 * that can never be edited -- unscrubbable by construction, and the one thing
 * that would make deletion and immutability genuinely irreconcilable (ADR 0006
 * amendment).
 *
 * Declared as an explicit sub-schema with `strict: 'throw'` for a reason found
 * by testing it. With an inline array definition, adding a `snippet` field made
 * Mongoose DISCARD THE ENTIRE EVIDENCE ENTRY SILENTLY -- the proposal saved
 * with zero evidence, no error, and nobody was told. In the collection whose
 * job is to prove what happened, silently losing evidence is a far worse
 * failure than refusing the write.
 *
 * With the explicit sub-schema the entry is still not cast, but validation now
 * FAILS with an error on `evidence`, so the proposal cannot be persisted and
 * the caller is told why. Loud beats silent.
 */
const evidenceRefSchema = new Schema(
  {
    kind: { type: String, enum: ['kb_chunk', 'tool_result'], required: true },
    ref: { type: String, required: true },
  },
  { _id: false, strict: 'throw' },
);
const proposalSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    actionType: { type: String, required: true, enum: ['order.cancel'] },
    target: {
      _id: false,
      kind: { type: String, required: true, enum: ['order'] },
      orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
      orderNumber: { type: String, required: true },
    },
    resolvedArgs: { type: Schema.Types.Mixed, default: {} },
    /** REFERENCES ONLY, never snippets — see `evidenceRefSchema`. */
    evidence: { type: [evidenceRefSchema], default: [] },
    model: {
      _id: false,
      name: { type: String, default: null },
      promptVersion: { type: String, default: null },
      latencyMs: { type: Number, default: null },
    },
    correlationId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
proposalSchema.plugin(immutablePlugin);
proposalSchema.index({ tenantId: 1, conversationId: 1, createdAt: -1 });

/* ── ActionOutcome — how it ended ───────────────────────────────────────── */
export const OUTCOMES = [
  'refused_at_proposal',
  'escalated_at_proposal',
  'rejected_by_customer',
  'expired',
  'refused_at_execution',
  'executed',
  'failed',
];

const decisionSchema = new Schema(
  {
    _id: false,
    ruleId: { type: Schema.Types.ObjectId, ref: 'PolicyRule', default: null },
    ruleKey: { type: String, default: null },
    ruleVersion: { type: Number, default: null },
    outcome: { type: String, enum: OUTCOME_LADDER, required: true },
    matched: { type: [String], default: [] },
  },
  { _id: false },
);

const outcomeSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    proposalId: { type: Schema.Types.ObjectId, ref: 'ActionProposal', required: true },
    outcome: { type: String, enum: OUTCOMES, required: true },
    /** Both decisions, side by side, so "authorised, then refused" is legible
     *  after the fact. A single field could not express that (ADR 0003). */
    decisionAtProposal: { type: decisionSchema, required: true },
    decisionAtExecution: { type: decisionSchema, default: null },
    confirmation: {
      _id: false,
      userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      at: { type: Date, default: null },
      /** The EXACT string shown to the customer. Storing it is how "the UI
       *  showed the real action" becomes provable rather than intended. */
      confirmedText: { type: String, default: null },
    },
    idempotencyKey: { type: String, required: true },
    result: {
      _id: false,
      orderVersionBefore: { type: Number, default: null },
      orderVersionAfter: { type: Number, default: null },
      cancellationRef: { type: String, default: null },
    },
    error: {
      _id: false,
      code: { type: String, default: null },
      message: { type: String, default: null },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
outcomeSchema.plugin(immutablePlugin);

/**
 * The two load-bearing indexes in the system.
 *
 * `idempotencyKey` unique is what ENFORCES once-only execution (ADR 0003).
 * Two concurrent confirmations race; one inserts, the other hits the unique
 * violation and reads back the winner's result. An application-level "have I
 * seen this key" check is a cache in front of this, never a substitute -- it
 * loses the race this index wins.
 */
outcomeSchema.index({ idempotencyKey: 1 }, { unique: true });
outcomeSchema.index({ proposalId: 1 }, { unique: true });
outcomeSchema.index({ tenantId: 1, createdAt: -1 });
outcomeSchema.index({ tenantId: 1, outcome: 1, createdAt: -1 });

/* ── TicketEvent ────────────────────────────────────────────────────────── */
const ticketEventSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', required: true },
    /** Monotonic per ticket. `createdAt` cannot order two events in the same
     *  millisecond; the unique index also makes concurrent transitions collide
     *  loudly instead of interleaving silently. */
    seq: { type: Number, required: true, min: 1 },
    type: {
      type: String,
      required: true,
      enum: ['created', 'assigned', 'status_changed', 'escalated', 'note'],
    },
    fromStatus: { type: String, default: null },
    toStatus: { type: String, default: null },
    actor: {
      _id: false,
      kind: { type: String, enum: ['system', 'user', 'assistant'], required: true },
      userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },
    /**
     * Enumerated, not free text.
     *
     * This field is the residual privacy risk named in Phase 3 section 7: it
     * lives in an immutable row, so anything written here can never be
     * scrubbed. Constraining it to an enum removes the risk for system- and
     * assistant-generated events; agent prose goes to the mutable
     * `Ticket.note` instead.
     */
    reason: {
      type: String,
      default: null,
      enum: [
        null,
        'policy_agent_only',
        'policy_refused',
        'low_confidence',
        'customer_request',
        'agent_action',
        'sla_breach',
      ],
    },
    correlationId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
ticketEventSchema.plugin(immutablePlugin);
ticketEventSchema.index({ tenantId: 1, ticketId: 1, seq: 1 }, { unique: true });

export const PolicyRule = model('PolicyRule', policyRuleSchema);
export const ActionProposal = model('ActionProposal', proposalSchema);
export const ActionOutcome = model('ActionOutcome', outcomeSchema);
export const TicketEvent = model('TicketEvent', ticketEventSchema);
