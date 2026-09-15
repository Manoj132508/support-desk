import { AppError } from '../errors/AppError.js';
import { LEGAL_TRANSITIONS, TICKET_STATUS } from '../domain/ticketState.js';
import { ConcurrentModificationError } from '../policy/actionService.js';
import { decodeCursor, encodeCursor, kindOf } from '../policy/auditQuery.js';
import { ESCALATION_REASON } from './escalation.js';

/**
 * Tickets, as the routes see them. FR-8.2, FR-9, FR-10.
 *
 * The repository decides what is written and whether it is allowed; this module
 * validates what a request asked for and decides what the caller is TOLD. Two
 * audiences:
 *
 *   Staff  see the internal channel (ADR 0007): rule keys, versions, matched
 *          conditions, and the rule's internal reason beside its customer text
 *          -- a blocked action "with the policy rule that blocked it" (FR-10.3).
 *   A customer asking for a person learns that a colleague is coming, and the
 *          ticket's reference. Not its reason, its assignee or its history.
 */

const STATUSES = new Set(Object.values(TICKET_STATUS));
const ALLOWED_PARAMS = new Set(['status', 'limit', 'cursor']);
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Attempts a person should see first: everything the assistant was stopped
 *  from doing, or could not do. */
const BLOCKED_KINDS = new Set([
  'malformed',
  'refused_at_proposal',
  'escalated_at_proposal',
  'refused_at_execution',
  'failed',
]);

const idOf = (value) => (value === null || value === undefined ? null : String(value));

/** Parse the queue's query string. An unrecognised parameter is an error, never
 *  ignored: a filter silently dropped shows an agent the wrong queue. */
export function parseTicketQuery(raw = {}) {
  const problems = [];
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_PARAMS.has(key)) problems.push(`unknown filter "${key}"`);
  }

  const value = { status: null, limit: DEFAULT_LIMIT, after: null };

  if (raw.status !== undefined) {
    if (typeof raw.status === 'string' && STATUSES.has(raw.status)) value.status = raw.status;
    else problems.push(`status must be one of ${[...STATUSES].join(', ')}`);
  }

  if (raw.limit !== undefined) {
    const limit = typeof raw.limit === 'string' && /^\d+$/.test(raw.limit) ? Number(raw.limit) : NaN;
    if (limit >= 1 && limit <= MAX_LIMIT) value.limit = limit;
    else problems.push(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  }

  if (raw.cursor !== undefined) {
    const decoded = typeof raw.cursor === 'string' ? decodeCursor(raw.cursor) : null;
    if (decoded) value.after = { openedAt: decoded.createdAt, id: decoded.id };
    else problems.push('cursor is not valid');
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, value };
}

export function ticketView(ticket) {
  return {
    id: idOf(ticket._id),
    conversationId: idOf(ticket.conversationId),
    customerId: idOf(ticket.customerId),
    status: ticket.currentStatus,
    active: ticket.active !== false,
    assigneeId: idOf(ticket.assigneeId),
    reason: ticket.reason ?? null,
    priority: ticket.priority ?? 'normal',
    openedAt: ticket.openedAt ?? null,
    closedAt: ticket.closedAt ?? null,
    // The moves the console may offer. The server rejects anything else anyway
    // (FR-9.2); this only saves the console from re-deriving the machine.
    legalMoves: [...(LEGAL_TRANSITIONS[ticket.currentStatus] ?? [])],
  };
}

function eventView(event) {
  return {
    seq: event.seq,
    type: event.type,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus ?? null,
    actor: { kind: event.actor?.kind ?? null, userId: idOf(event.actor?.userId) },
    reason: event.reason ?? null,
    proposalId: idOf(event.proposalId),
    at: event.createdAt ?? null,
  };
}

function messageView(message) {
  return {
    id: idOf(message._id),
    role: message.role,
    content: message.content ?? '',
    state: message.state ?? 'complete',
    evidence: (message.evidence ?? []).map((item) => ({ kind: item.kind, ref: item.ref })),
    proposalId: idOf(message.proposalId),
    at: message.createdAt ?? null,
  };
}

function attemptView({ proposal, outcome, decisions }, rulesById) {
  const kind = kindOf({ validity: proposal.validity, outcome });
  return {
    proposalId: idOf(proposal._id),
    at: proposal.createdAt ?? null,
    kind,
    blocked: BLOCKED_KINDS.has(kind),
    validity: proposal.validity,
    problemCodes: [...(proposal.problemCodes ?? [])],
    actionType: proposal.actionType ?? null,
    orderNumber: proposal.target?.orderNumber ?? null,
    confirmText: proposal.confirmText ?? null,
    decisions: decisions.map((row) => {
      // The exact version that decided: each version is its own rule row.
      const rule = rulesById.get(idOf(row.decision?.ruleId));
      return {
        stage: row.stage,
        outcome: row.decision?.outcome ?? null,
        ruleKey: row.decision?.ruleKey ?? null,
        ruleVersion: row.decision?.ruleVersion ?? null,
        matched: [...(row.decision?.matched ?? [])],
        defaulted: row.defaulted === true,
        reason: row.reason ?? null,
        internalReason: rule?.internalReason ?? null,
        customerMessage: rule?.customerMessage ?? null,
      };
    }),
  };
}

export function makeTicketService({ repo } = {}) {
  if (!repo) throw new TypeError('makeTicketService requires a repo');

  return {
    async list(ctx, rawQuery) {
      const parsed = parseTicketQuery(rawQuery);
      if (!parsed.ok) throw AppError.malformed(`Invalid ticket query: ${parsed.problems.join('; ')}`);
      const { status, limit, after } = parsed.value;

      const [rows, counts] = await Promise.all([
        repo.listTickets(ctx, { status, after, limit }),
        repo.countByStatus(ctx),
      ]);

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        tickets: page.map(ticketView),
        counts,
        page: {
          limit,
          nextCursor: rows.length > limit && last ? encodeCursor({ createdAt: last.openedAt, id: last._id }) : null,
        },
      };
    },

    async detail(ctx, ticketId) {
      const ticket = await repo.findTicket(ctx, ticketId);
      if (!ticket) throw AppError.notFound();

      const [events, conversation, messages, attempts] = await Promise.all([
        repo.listEvents(ctx, ticket._id),
        repo.findConversation(ctx, ticket.conversationId),
        repo.listMessages(ctx, ticket.conversationId),
        repo.listAttempts(ctx, ticket.conversationId),
      ]);

      const ruleIds = [
        ...new Set(attempts.flatMap((attempt) => attempt.decisions.map((row) => idOf(row.decision?.ruleId)).filter(Boolean))),
      ];
      const rules = ruleIds.length > 0 ? await repo.findRules(ctx, ruleIds) : [];
      const rulesById = new Map(rules.map((rule) => [idOf(rule._id), rule]));

      return {
        ticket: ticketView(ticket),
        events: events.map(eventView),
        conversation: conversation
          ? { id: idOf(conversation._id), customerId: idOf(conversation.customerId), status: conversation.status, startedAt: conversation.createdAt ?? null }
          : null,
        messages: messages.map(messageView),
        attempts: attempts.map((attempt) => attemptView(attempt, rulesById)),
      };
    },

    async transition(ctx, { ticketId, to, user, correlationId = null }) {
      if (typeof to !== 'string' || to === '') throw AppError.malformed('A ticket status change needs a status');

      let updated;
      try {
        updated = await repo.transition(ctx, {
          ticketId,
          to,
          actor: { kind: 'user', userId: user.id },
          correlationId,
        });
      } catch (error) {
        if (error instanceof ConcurrentModificationError) {
          throw AppError.stale('The ticket changed before this update was applied. Reload it and try again.');
        }
        throw error;
      }

      if (!updated) throw AppError.notFound();
      return { ticket: ticketView(updated) };
    },

    /**
     * A customer asking for a person (FR-8.2, ADR 0010).
     *
     * The reason is DERIVED, never taken from the request. A proposal id in the
     * body counts only if the server finds that proposal in this customer's
     * conversation with a refusal recorded against it; anything else is simply
     * a request for a person.
     */
    async escalateForCustomer(ctx, { customerId, conversationId, proposalId = null, userId, correlationId = null }) {
      const conversation = await repo.findCustomerConversation(ctx, customerId, conversationId);
      if (!conversation) throw AppError.notFound();

      const refused = proposalId
        ? await repo.findRefusedProposal(ctx, { customerId, conversationId: conversation._id, proposalId })
        : null;

      const result = await repo.escalate(ctx, {
        conversationId: conversation._id,
        customerId,
        reason: refused ? ESCALATION_REASON.POLICY_REFUSED : ESCALATION_REASON.CUSTOMER_REQUEST,
        actor: { kind: 'user', userId },
        proposalId: refused ? refused._id : null,
        correlationId,
      });

      return { escalation: { ticketId: idOf(result.ticketId), status: result.status, created: result.created } };
    },
  };
}
