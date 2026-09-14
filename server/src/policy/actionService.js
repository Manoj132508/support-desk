import { evaluate, toStoredDecision } from './engine.js';
import {
  validateProposalShape,
  resolveTarget,
  renderConfirmText,
  UNRESOLVED_TARGET,
} from './proposal.js';
import { AppError } from '../errors/AppError.js';

/**
 * PROPOSE → CONFIRM → EXECUTE. The orchestration around the pure engine.
 *
 * This is where ADR 0002's six steps happen, in order, and where ADR 0003's
 * re-check and idempotency are enforced. The engine decides; this module makes
 * sure every decision is taken at the right moment, against the right facts,
 * and recorded before anything acts on it.
 *
 * Every read and write goes through an injected `repo`. Not ceremony: it is
 * what lets the sequencing -- the part most likely to be subtly wrong -- be
 * tested exhaustively without a database, including the cases a database makes
 * hard to reproduce on demand: two confirmations racing, the order shipping
 * between proposal and confirmation, and a transaction that commits and then
 * reports an error.
 */

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** Thrown by a repo when a conditional write finds the record has moved on. */
export class ConcurrentModificationError extends Error {
  constructor(message = 'The record changed between reading and writing') {
    super(message);
    this.name = 'ConcurrentModificationError';
  }
}

/**
 * ADR 0003: derived from the proposal, and from nothing else.
 *
 * One proposal executes at most once, ever. A client-supplied key would be
 * attacker-controlled and would express a weaker rule; a key that included a
 * timestamp or attempt number would let the same proposal execute twice. The
 * unique index on this value is the enforcement -- this function only names it.
 */
export function idempotencyKeyFor(proposalId) {
  return `proposal:${String(proposalId)}`;
}

/* Static, rule-independent customer text for states that are not policy
 * decisions (ADR 0007: never model-generated). */
const ALREADY_DECIDED = "This has already been dealt with, so there's nothing more to confirm.";
const ORDER_CHANGED = "This order changed a moment ago, so I haven't made any changes. Please try again.";
const ORDER_GONE = "I can't find that order any more, so I haven't made any changes.";

function detailFor(decision, stage) {
  return {
    stage,
    ruleKey: decision.ruleKey,
    ruleVersion: decision.ruleVersion,
    outcome: decision.outcome,
    matched: [...(decision.matched ?? [])],
    reason: decision.reason ?? null,
  };
}

const noop = () => {};

export function makeActionService({ repo, clock = () => new Date(), log = noop } = {}) {
  if (!repo) throw new TypeError('makeActionService requires a repo');

  /** The facts the engine reasons over, and only those. */
  async function buildWorld(ctx, customerId, order, now) {
    const orderCount90d = await repo.countRecentOrders(
      ctx,
      customerId,
      new Date(now.getTime() - NINETY_DAYS_MS),
    );
    return {
      order: {
        status: order.status,
        totalMinor: order.totalMinor,
        currency: order.currency,
        placedAt: order.placedAt,
      },
      customer: { orderCount90d },
    };
  }

  /**
   * Evaluate, and RECORD the evaluation, before returning it.
   *
   * Recording each evaluation as its own immutable row is what lets a pending
   * proposal carry its authorisation across two HTTP requests. The proposal
   * row is written before evaluation (ADR 0002 step 2) and can never be
   * edited, so the proposal-time decision cannot be written back onto it; and
   * reconstructing it at confirm time would be impossible, because the rules
   * may have been edited in between -- which is the entire point of ADR 0003.
   */
  async function decide(ctx, { proposal, order, customerId, stage }) {
    const now = clock();
    const [rules, world] = await Promise.all([
      repo.loadRules(ctx, proposal.actionType),
      buildWorld(ctx, customerId, order, now),
    ]);

    const decision = evaluate({ rules, proposal: { actionType: proposal.actionType }, world, now });

    await repo.recordDecision(ctx, {
      proposalId: proposal._id,
      stage,
      decision: toStoredDecision(decision),
      defaulted: decision.defaulted,
      reason: decision.reason,
      clampedFrom: decision.clampedFrom,
    });

    return decision;
  }

  /* ── Propose ─────────────────────────────────────────────────────────── */

  /**
   * Returns one of:
   *   { kind: 'malformed', proposalId, codes }
   *   { kind: 'refused',   proposalId, decision }
   *   { kind: 'escalated', proposalId, decision }
   *   { kind: 'confirm',   proposalId, confirmText, decision }
   *
   * Every branch records something. There is no path through this function in
   * which the model proposed an action and no trace of it remains.
   */
  async function propose({ ctx, customerId, conversationId, messageId = null, raw, correlationId = null }) {
    const common = { customerId, conversationId, messageId, correlationId };

    // Step 1: SHAPE. A malformed attempt is recorded, as codes, and goes no
    // further -- the engine never sees anything that is not exactly the right
    // shape.
    const shape = validateProposalShape(raw);
    if (!shape.ok) {
      const record = await repo.recordProposal(ctx, {
        ...common,
        validity: 'malformed',
        problemCodes: shape.codes,
      });
      // The readable messages echo model-supplied text, so they go to the
      // logs and never into the immutable row.
      log('proposal_malformed', {
        proposalId: record._id,
        codes: shape.codes,
        problems: shape.problems.map((p) => p.message),
        correlationId,
      });
      return { kind: 'malformed', proposalId: record._id, codes: shape.codes };
    }

    // Resolution, scoped to this tenant AND this customer (ADR 0005). Another
    // customer's order and a nonexistent one are indistinguishable here, so
    // both are recorded identically.
    const order = await repo.findCustomerOrder(ctx, customerId, shape.value.target.orderNumber);
    if (!order) {
      const record = await repo.recordProposal(ctx, {
        ...common,
        validity: 'malformed',
        problemCodes: [UNRESOLVED_TARGET],
      });
      return { kind: 'malformed', proposalId: record._id, codes: [UNRESOLVED_TARGET] };
    }

    const resolved = resolveTarget(shape.value, order);

    // Step 2: PERSIST, before evaluation. The confirmation text is rendered
    // now, from the record, and stored with the proposal -- so what the dialog
    // shows and what the audit says the customer confirmed are the same string
    // by construction, not by two renders agreeing.
    const proposal = await repo.recordProposal(ctx, {
      ...common,
      validity: 'resolved',
      actionType: resolved.actionType,
      target: resolved.target,
      evidence: resolved.evidence,
      resolvedArgs: { reasonCode: resolved.reasonCode },
      confirmText: renderConfirmText(resolved.actionType, order),
    });

    // Step 3: EVALUATE.
    const decision = await decide(ctx, { proposal, order, customerId, stage: 'proposal' });

    if (decision.outcome === 'confirm-required') {
      // Pending. No outcome row: a proposal with no outcome is awaiting the
      // customer (Phase 3 §4), and nothing has been authorised yet.
      return {
        kind: 'confirm',
        proposalId: proposal._id,
        confirmText: proposal.confirmText,
        decision,
      };
    }

    // refuse → refused. EVERYTHING ELSE → escalated, including any outcome this
    // code does not expect. The engine clamps auto-execute, so it should never
    // arrive here; if it somehow did, the safe reading is "a human looks", not
    // "proceed".
    const refused = decision.outcome === 'refuse';
    await repo.recordOutcome(ctx, {
      proposalId: proposal._id,
      outcome: refused ? 'refused_at_proposal' : 'escalated_at_proposal',
      decisionAtProposal: toStoredDecision(decision),
      decisionAtExecution: null,
      idempotencyKey: idempotencyKeyFor(proposal._id),
    });

    return { kind: refused ? 'refused' : 'escalated', proposalId: proposal._id, decision };
  }

  /* ── Shared checks for confirm and reject ────────────────────────────── */

  async function loadPending(ctx, customerId, proposalId, { acceptDuplicateOf }) {
    // Scoped to the customer: someone else's proposal is a 404, not a 403,
    // and a malformed one was never offered for confirmation at all.
    const proposal = await repo.findProposal(ctx, customerId, proposalId);
    if (!proposal || proposal.validity !== 'resolved') throw AppError.notFound();

    const existing = await repo.findOutcome(ctx, proposal._id);
    if (existing) {
      if (existing.outcome === acceptDuplicateOf) return { proposal, duplicate: existing };
      throw AppError.stale('Proposal already decided', { customerMessage: ALREADY_DECIDED });
    }

    // The proposal-time decision, as RECORDED -- never re-derived. If there is
    // none, or it was not confirm-required, this proposal was never offered to
    // the customer, whatever the request claims.
    const decisionAtProposal = await repo.findDecision(ctx, proposal._id, 'proposal');
    if (!decisionAtProposal || decisionAtProposal.outcome !== 'confirm-required') {
      throw AppError.stale('Proposal was never offered for confirmation', {
        customerMessage: ALREADY_DECIDED,
      });
    }

    return { proposal, decisionAtProposal };
  }

  /* ── Confirm ─────────────────────────────────────────────────────────── */

  async function confirm({ ctx, customerId, proposalId, userId }) {
    const pending = await loadPending(ctx, customerId, proposalId, { acceptDuplicateOf: 'executed' });

    // A retried confirmation returns the ORIGINAL result, unchanged (ADR 0003).
    // Not an error: the caller asked for the action to have happened, and it has.
    if (pending.duplicate) return { kind: 'executed', outcome: pending.duplicate, duplicate: true };

    const { proposal, decisionAtProposal } = pending;

    if (proposal.actionType !== 'order.cancel') {
      throw AppError.fault(`No executor for ${proposal.actionType}`);
    }

    const order = await repo.findOrderById(ctx, customerId, proposal.target.orderId);
    if (!order) throw AppError.stale('Target order no longer exists', { customerMessage: ORDER_GONE });

    // Step 5a: RE-EVALUATE against the world as it is NOW (ADR 0003). The
    // order may have shipped; the rule may have been edited. An authorisation
    // decision has a shelf life, and treating it as permanent is the classic
    // time-of-check to time-of-use bug.
    const decisionAtExecution = await decide(ctx, {
      proposal,
      order,
      customerId,
      stage: 'execution',
    });

    const confirmation = { userId, at: clock(), confirmedText: proposal.confirmText };
    const outcomeBase = {
      proposalId: proposal._id,
      decisionAtProposal,
      decisionAtExecution: toStoredDecision(decisionAtExecution),
      confirmation,
      idempotencyKey: idempotencyKeyFor(proposal._id),
    };

    if (decisionAtExecution.outcome !== 'confirm-required') {
      // Authorised, then refused. A first-class outcome, recorded with BOTH
      // decisions so the sequence is legible afterwards -- not swept into a
      // generic error.
      const { outcome, duplicate } = await repo.recordOutcome(ctx, {
        ...outcomeBase,
        outcome: 'refused_at_execution',
      });
      // A concurrent confirmation may have executed first under the old facts.
      // If so, that result stands, and this request reports it.
      if (duplicate && outcome.outcome === 'executed') {
        return { kind: 'executed', outcome, duplicate: true };
      }
      throw AppError.stale(
        `Refused at execution by ${decisionAtExecution.ruleKey ?? decisionAtExecution.reason}`,
        {
          customerMessage: decisionAtExecution.customerMessage,
          detail: detailFor(decisionAtExecution, 'execution'),
        },
      );
    }

    // Step 5b: EXECUTE. The repo commits the order change and the outcome row
    // in one transaction, conditional on the order's version, keyed by the
    // idempotency key.
    try {
      const { outcome, duplicate } = await repo.executeCancellation(ctx, {
        proposal,
        order,
        outcome: { ...outcomeBase, outcome: 'executed' },
      });
      if (outcome.outcome !== 'executed') {
        // The key is already held by a different terminal outcome.
        throw AppError.stale('Proposal already decided', { customerMessage: ALREADY_DECIDED });
      }
      return { kind: 'executed', outcome, duplicate };
    } catch (error) {
      if (error instanceof AppError) throw error;

      if (error instanceof ConcurrentModificationError) {
        // The order moved between the re-check and the write. Nothing was
        // written, the proposal is still pending, and a retry will re-evaluate
        // against the new facts -- which is exactly the behaviour wanted.
        throw AppError.stale('Order changed during execution', { customerMessage: ORDER_CHANGED });
      }

      /*
       * A fault. Record a terminal `failed` outcome, so an agent looks rather
       * than the proposal silently hanging.
       *
       * THE AMBIGUOUS COMMIT. A transaction can commit and the driver still
       * report an error -- a connection reset after the server applied the
       * write. In that case the idempotency key already holds an `executed`
       * outcome, the insert below hits the unique index, and the repo returns
       * the existing row. The action DID happen, so this request reports it.
       * Idempotency is what turns "we don't know whether it worked" into a
       * question with an answer.
       *
       * The error MESSAGE is not stored: driver messages can include values
       * from the failed write, and this row can never be edited. A code only.
       */
      let recorded = null;
      try {
        recorded = await repo.recordOutcome(ctx, {
          ...outcomeBase,
          outcome: 'failed',
          error: { code: 'execution_fault', message: null },
        });
      } catch {
        // The database may be the thing that failed. The original error is the
        // one worth reporting; this one would only obscure it.
      }

      if (recorded?.duplicate && recorded.outcome.outcome === 'executed') {
        log('execution_ambiguous_commit_resolved', { proposalId: proposal._id });
        return { kind: 'executed', outcome: recorded.outcome, duplicate: true };
      }

      log('execution_fault', { proposalId: proposal._id, error: error.message });
      throw AppError.fault('Execution failed');
    }
  }

  /* ── Reject ──────────────────────────────────────────────────────────── */

  async function reject({ ctx, customerId, proposalId, userId }) {
    const pending = await loadPending(ctx, customerId, proposalId, {
      acceptDuplicateOf: 'rejected_by_customer',
    });
    if (pending.duplicate) return { kind: 'rejected', outcome: pending.duplicate, duplicate: true };

    const { proposal, decisionAtProposal } = pending;

    // An explicit act (ADR 0009 property 4). Dismissing the dialog does not
    // call this; only "Keep my order" does.
    const { outcome, duplicate } = await repo.recordOutcome(ctx, {
      proposalId: proposal._id,
      outcome: 'rejected_by_customer',
      decisionAtProposal,
      decisionAtExecution: null,
      confirmation: { userId, at: clock(), confirmedText: null },
      idempotencyKey: idempotencyKeyFor(proposal._id),
    });

    // Lost a race to a confirmation: the order was cancelled, and saying
    // otherwise would be false.
    if (duplicate && outcome.outcome !== 'rejected_by_customer') {
      throw AppError.stale('Proposal already decided', { customerMessage: ALREADY_DECIDED });
    }
    return { kind: 'rejected', outcome, duplicate };
  }

  return { propose, confirm, reject };
}
