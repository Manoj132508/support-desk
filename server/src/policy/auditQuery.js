import { AppError } from '../errors/AppError.js';
import { OUTCOMES } from '../db/models/index.js';
import { ACTION_TYPES } from './vocabulary.js';

/**
 * The audit query. FR-11.
 *
 * The question this exists to answer is the demo that sells the project:
 * *what did the assistant try to do this week that it was not allowed to do?*
 * Three rules follow from taking that question seriously.
 *
 *   1. REFUSALS ARE INCLUDED BY DEFAULT (FR-11.2). Excluding them takes an
 *      explicit filter. A default that showed only successful actions would
 *      answer a different, much less interesting question.
 *
 *   2. MALFORMED ATTEMPTS ARE INCLUDED TOO. An attempt that never reached the
 *      policy engine -- including one that tried to assert its own
 *      authorisation -- is part of "what the assistant tried to do", arguably
 *      the most important part. So the unit of the audit is the ATTEMPT (every
 *      ActionProposal), with its outcome joined on where one exists, rather than
 *      the outcome table alone.
 *
 *   3. AN UNRECOGNISED FILTER IS AN ERROR, not something to ignore. A lead who
 *      types `kinds=` instead of `kind=` and gets back an unfiltered list would
 *      reasonably believe they had filtered it. For an audit, a silently ignored
 *      filter is a misleading answer.
 */

/** Every state an attempt can be in: never evaluated, awaiting the customer,
 *  or one of the seven terminal outcomes. */
export const ATTEMPT_KINDS = Object.freeze(['malformed', 'pending', ...OUTCOMES]);

/**
 * The preset for the question above. Refused and escalated at proposal, refused
 * at execution, and malformed. Customer rejections are deliberately not in it:
 * the customer declining is not the assistant being stopped.
 */
export const STOPPED_KINDS = Object.freeze([
  'malformed',
  'refused_at_proposal',
  'escalated_at_proposal',
  'refused_at_execution',
]);

const ALLOWED_PARAMS = new Set(['kind', 'preset', 'actionType', 'customerId', 'from', 'to', 'limit', 'cursor']);
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Derive an attempt's kind. Shared by the service and by the repo, so the
 *  filter and the label cannot disagree about what an attempt is. */
export function kindOf(attempt) {
  if (attempt.validity === 'malformed') return 'malformed';
  if (attempt.outcome) return attempt.outcome.outcome;
  return 'pending';
}

/**
 * Keyset cursors, on (createdAt, _id), newest first.
 *
 * NOT OFFSET PAGINATION, and the reason is specific to this data. The audit is
 * append-only and new attempts arrive at the top while a lead is paging. With
 * `skip`, every new row pushes the next page down by one: rows are shown twice
 * or skipped entirely, and the lead never knows. A cursor that says "strictly
 * older than this row" is unaffected by what arrives above it.
 *
 * The cursor is opaque to the client but it is not a security boundary -- the
 * tenant filter is applied to every query regardless of what a cursor says.
 */
export function encodeCursor({ createdAt, id }) {
  return Buffer.from(
    JSON.stringify({ t: new Date(createdAt).toISOString(), i: String(id) }),
  ).toString('base64url');
}

export function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.t !== 'string' || typeof parsed.i !== 'string') return null;
    const createdAt = new Date(parsed.t);
    if (Number.isNaN(createdAt.getTime()) || !OBJECT_ID.test(parsed.i)) return null;
    return { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

function parseDate(value, name, problems) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    problems.push(`${name} must be a date, such as 2026-09-14 or 2026-09-14T12:00:00Z`);
    return null;
  }
  return date;
}

/** Parse and validate query-string parameters. Returns `{ ok, value, problems }`. */
export function parseAuditQuery(raw = {}) {
  const problems = [];
  const value = {
    kinds: null,
    actionType: null,
    customerId: null,
    from: null,
    to: null,
    before: null,
    limit: DEFAULT_LIMIT,
  };

  for (const [key, given] of Object.entries(raw)) {
    if (!ALLOWED_PARAMS.has(key)) {
      problems.push(`unknown filter "${key}" (allowed: ${[...ALLOWED_PARAMS].join(', ')})`);
    } else if (Array.isArray(given)) {
      // `?kind=a&kind=b` arrives as an array. Picking one silently would make
      // the result depend on which one was picked; asking for a comma list is
      // unambiguous.
      problems.push(`"${key}" was given more than once — use a comma-separated list`);
    }
  }
  if (problems.length) return { ok: false, value: null, problems };

  if (raw.kind !== undefined && raw.preset !== undefined) {
    problems.push('use either kind or preset, not both');
  } else if (raw.preset !== undefined) {
    if (raw.preset === 'stopped') value.kinds = [...STOPPED_KINDS];
    else problems.push('preset must be "stopped"');
  } else if (raw.kind !== undefined) {
    const kinds = [...new Set(String(raw.kind).split(',').map((k) => k.trim()).filter(Boolean))];
    const unknown = kinds.filter((k) => !ATTEMPT_KINDS.includes(k));
    if (!kinds.length) problems.push('kind must name at least one kind');
    else if (unknown.length) problems.push(`unknown kind: ${unknown.join(', ')}`);
    else value.kinds = kinds;
  }

  if (raw.actionType !== undefined) {
    if (ACTION_TYPES.includes(raw.actionType)) value.actionType = raw.actionType;
    else problems.push(`actionType must be one of: ${ACTION_TYPES.join(', ')}`);
  }

  if (raw.customerId !== undefined) {
    // Validated rather than handed to the database, where a malformed id would
    // throw a CastError and a 500.
    if (OBJECT_ID.test(raw.customerId)) value.customerId = raw.customerId;
    else problems.push('customerId is not a valid id');
  }

  if (raw.from !== undefined) value.from = parseDate(raw.from, 'from', problems);
  if (raw.to !== undefined) value.to = parseDate(raw.to, 'to', problems);
  if (value.from && value.to && value.from > value.to) problems.push('from must not be after to');

  if (raw.limit !== undefined) {
    const limit = /^\d+$/.test(String(raw.limit)) ? Number(raw.limit) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      problems.push(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    } else {
      value.limit = limit;
    }
  }

  if (raw.cursor !== undefined) {
    const before = decodeCursor(String(raw.cursor));
    if (before) value.before = before;
    else problems.push('cursor is not valid — start again from the first page');
  }

  return problems.length ? { ok: false, value: null, problems } : { ok: true, value, problems: [] };
}

/**
 * One attempt, as staff see it.
 *
 * This is the INTERNAL channel, so decisions -- rule keys, versions, matched
 * conditions -- are included; that is the point of the audit. Built field by
 * field all the same, so nothing that happens to be on a database row is echoed
 * by accident. The customer is referenced by id only: after a deletion request
 * that id resolves to a scrubbed profile (ADR 0006 amendment).
 */
export function toAuditEntry(attempt) {
  const outcome = attempt.outcome ?? null;
  return {
    id: String(attempt._id),
    at: attempt.createdAt,
    kind: kindOf(attempt),
    actionType: attempt.actionType ?? null,
    customerId: attempt.customerId ? String(attempt.customerId) : null,
    conversationId: attempt.conversationId ? String(attempt.conversationId) : null,
    target: attempt.target?.orderNumber ? { kind: 'order', orderNumber: attempt.target.orderNumber } : null,
    problemCodes: [...(attempt.problemCodes ?? [])],
    decisionAtProposal: outcome?.decisionAtProposal ?? attempt.proposalDecision ?? null,
    decisionAtExecution: outcome?.decisionAtExecution ?? null,
    decidedAt: outcome?.createdAt ?? null,
    confirmedBy: outcome?.confirmation?.userId ? String(outcome.confirmation.userId) : null,
    errorCode: outcome?.error?.code ?? null,
  };
}

export function makeAuditQuery({ repo } = {}) {
  if (!repo) throw new TypeError('makeAuditQuery requires a repo');

  async function list(ctx, rawQuery) {
    if (!ctx?.tenantId) throw AppError.fault('The audit query requires a tenant context');

    const parsed = parseAuditQuery(rawQuery);
    if (!parsed.ok) throw AppError.malformed(`Invalid audit query: ${parsed.problems.join('; ')}`);

    const { limit, ...filters } = parsed.value;

    // One more than the page size: whether a next page exists is then known
    // without a separate count query over a table that only ever grows.
    const attempts = await repo.findAttempts(ctx, { ...filters, limit: limit + 1 });
    const page = attempts.slice(0, limit);
    const last = page[page.length - 1];

    return {
      entries: page.map(toAuditEntry),
      page: {
        limit,
        nextCursor:
          attempts.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last._id }) : null,
      },
    };
  }

  return { list };
}
