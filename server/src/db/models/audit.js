import mongoose from 'mongoose';
import { immutablePlugin } from '../plugins/immutable.js';
import {
  OUTCOME_LADDER,
  CONDITION_FIELDS,
  PROBLEM_CODES,
  DECISION_REASONS,
} from '../../policy/vocabulary.js';

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

/**
 * The ladder, the condition registry and the problem codes are declared in
 * policy/vocabulary.js, which imports nothing, so the policy engine can depend
 * on the vocabulary without depending on Mongoose. They are re-exported here
 * because the schemas below validate against them -- one definition, two
 * consumers.
 */
export { OUTCOME_LADDER, CONDITION_FIELDS, PROBLEM_CODES, DECISION_REASONS };

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
    outcome: { type: String, required: true, enum: [...OUTCOME_LADDER] },
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

/** Resolved fields are required unless the proposal was recorded as malformed. */
function isResolved() {
  return this.validity !== 'malformed';
}

const proposalSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    /**
     * Known when the row is written and never changes, so it belongs in an
     * immutable record.
     *
     * A MALFORMED proposal is still recorded (FR-4.3, ADR 0006): what the model
     * tried to do and was stopped from doing includes attempts too malformed to
     * evaluate. Phase 3 made target.orderId unconditionally required, which made
     * recording them impossible -- an attempt that never resolved has no order
     * to point at. Found while building the propose path in Phase 10. The
     * resolved fields are now required only for a resolved proposal.
     */
    validity: { type: String, enum: ['resolved', 'malformed'], required: true, default: 'resolved' },
    /**
     * CODES, never messages. A problem message can echo model-supplied text --
     * an unknown field name, an order number -- and free text in a row that can
     * never be edited is unscrubbable by construction, the same constraint that
     * keeps snippets out of evidence. The readable message goes to the logs,
     * which rotate; the audit keeps the enumerated reason.
     */
    problemCodes: { type: [{ type: String, enum: [...PROBLEM_CODES] }], default: [] },
    actionType: { type: String, required: isResolved, enum: ['order.cancel'] },
    target: {
      _id: false,
      kind: { type: String, required: isResolved, enum: ['order'] },
      orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: isResolved },
      orderNumber: { type: String, required: isResolved },
    },
    resolvedArgs: { type: Schema.Types.Mixed, default: {} },
    /**
     * The confirmation text, rendered by the SERVER from the order record when
     * the proposal is written (FR-6.1) -- never model output. Stored here so the
     * string the dialog displays and the string the audit says the customer
     * confirmed are the same value by construction, rather than two renders
     * that happen to agree. It names catalogue items, a total and a date --
     * nothing about the person -- which is why it may live in an immutable row.
     */
    confirmText: { type: String, required: isResolved, default: null },
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

/**
 * Serves the audit query's sort: tenant first, then newest first, with _id as
 * the tie-break the keyset cursor relies on. Without it the aggregation is
 * still correct -- and sorts every attempt in the tenant to return fifty, which
 * is fine at seed scale and a slow page on a log that only ever grows.
 */
proposalSchema.index({ tenantId: 1, createdAt: -1, _id: -1 });

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
    outcome: { type: String, enum: [...OUTCOME_LADDER], required: true },
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

/* ── PolicyDecision — one immutable row per evaluation ─────────────────────
 *
 * Added in Phase 10, reversing an alternative Phase 3 section 4 rejected. Phase 3
 * reasoned that a decision divorced from its proposal is not independently
 * meaningful, and embedded both decisions on ActionOutcome instead.
 *
 * What it did not foresee: a confirm-required proposal is PENDING across two
 * HTTP requests. Its proposal-time decision must survive until confirmation;
 * the proposal row is written before evaluation and can never be edited; and
 * no outcome row may exist yet, because a pending proposal is defined by having
 * none. Re-deriving the decision at confirm time is not an option either --
 * the rules may have changed in between, which is ADR 0003's entire point. So
 * each evaluation is recorded as its own row, referencing its proposal.
 *
 * ActionOutcome still embeds copies of both decisions, so an audit row stays
 * readable without a join. Duplicated data in immutable rows cannot drift.
 */
const policyDecisionSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    proposalId: { type: Schema.Types.ObjectId, ref: 'ActionProposal', required: true },
    stage: { type: String, enum: ['proposal', 'execution'], required: true },
    decision: { type: decisionSchema, required: true },
    defaulted: { type: Boolean, required: true },
    /** Why the engine failed closed, as a code -- never the engine's detail,
     *  which can name rule-authored fields and values. */
    reason: { type: String, default: null, enum: [null, ...DECISION_REASONS] },
    clampedFrom: { type: String, default: null, enum: [null, 'auto-execute'] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
policyDecisionSchema.plugin(immutablePlugin);
policyDecisionSchema.index({ tenantId: 1, proposalId: 1, stage: 1, createdAt: 1 });

/**
 * Exactly one PROPOSAL-stage decision per proposal: it is the authorisation a
 * confirmation relies on, and two would make "which one was offered?"
 * ambiguous. Execution-stage decisions are deliberately NOT unique -- a confirm
 * that hit a version conflict is legitimately retried, and each attempt is a
 * real evaluation worth keeping.
 */
policyDecisionSchema.index(
  { proposalId: 1, stage: 1 },
  { unique: true, partialFilterExpression: { stage: 'proposal' } },
);

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
export const PolicyDecision = model('PolicyDecision', policyDecisionSchema);
export const TicketEvent = model('TicketEvent', ticketEventSchema);
