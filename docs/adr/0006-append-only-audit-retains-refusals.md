# ADR 0006 — Append-only audit that retains refusals

- **Status:** Accepted
- **Date:** 2026-09-08 (Phase 2)
- **Enforces:** INV-B · **Satisfies:** FR-7.4, FR-11, FR-13.4
- **Relates to:** [ADR 0002](0002-llm-proposes-never-authorises.md),
  [ADR 0003](0003-recheck-at-execution-and-idempotency.md)

## Context

INV-A is a claim: *the model never takes an unauthorised action.* A claim needs evidence, and
there are only two kinds available. The policy eval proves it holds over a golden set — cases
we thought of. The audit log shows what happened in reality — cases we did not.

The instinct when designing an audit table is to record what the system **did**. That instinct
is wrong here. A log of successful cancellations proves the feature works; it says nothing about
whether anything was ever prevented. **The refusals are the evidence.** A month of "the model
proposed 47 cancellations, 12 were refused by policy, here are the rules that refused them" is
the entire argument for the project, and a log of the 35 successes throws it away.

The second force is standard: an audit record that can be edited is not an audit record.

The third force is uncomfortable, and Phase 1 (FR-13.4) already named it. A customer exercising
a deletion right wants their data gone. The audit trail is the evidence INV-A works. These are
in genuine conflict, and there is no design that fully satisfies both.

## Decision

**Three append-only collections**, using the `immutablePlugin` ported from Project 2:
`ActionProposal`, `ActionExecution`, `TicketEvent`. No update path exists — the plugin rejects
`save()` on a loaded document and every update operator at the model level. State changes are
expressed by appending a new record, never by editing an old one.

**Every proposal is persisted before it is evaluated** (ADR 0002, step 2). Persistence is not
conditional on the outcome, so there is no branch in which a proposal goes unrecorded — and
recording *cannot* be skipped by the path that refuses.

**Refusals are retained and are queryable by default.** `GET /api/audit` includes refused,
rejected, and refused-at-execution outcomes without opting in; excluding them requires an
explicit filter. The default answers the question that matters: *what did the assistant try to
do that it was not allowed to do?* (FR-11)

**Each `ActionExecution` carries the full decision history:** proposal ref, the proposal-time
decision, the execution-time decision (ADR 0003), rule id and version for both, the
confirmation record, the idempotency key, outcome, and timestamps. Both decisions are stored
because "authorised, then refused" is a real and interesting sequence that a single field
cannot express.

**Deletion de-identifies rather than removes.** A deletion request cascades across
conversations, messages, and tickets. Audit records are **retained with the subject
de-identified** — customer reference replaced by an irreversible pseudonym, free text purged,
the decision structure kept intact. What survives is *a cancellation was proposed for an order
in this state, and rule R7 v2 refused it*. What goes is *who*.

This is a documented compromise, not a solved problem. The README states it in these terms
rather than implying the tension does not exist.

## Consequences

**Positive**

- INV-A becomes demonstrable from production data, not only from tests.
- Immutability is enforced by the model layer, so no controller can violate it by accident.
- The "authorised then refused" sequence is legible, which makes ADR 0003 auditable.
- Post-incident questions are answerable: which rule, which version, who confirmed, when.

**Negative**

- Storage grows monotonically, including from proposals that never executed. Accepted at this
  scale; retention windows are future work and would themselves need to be audited.
- Corrections cannot be made by editing. A wrong record is superseded by an appended one, and
  readers must understand they are reading a sequence rather than a row. Query helpers hide
  this for the common cases.
- De-identification is irreversible by design, so a deletion cannot be undone.
- A privacy reviewer may reasonably object to retaining anything. The counter-argument is
  written down rather than assumed, which is the most this project can honestly do.

**Neutral**

- `Ticket` keeps a denormalised `currentStatus` for queue queries, derived from the
  `TicketEvent` sequence. The events remain the source of truth; the field is a cache, and a
  test asserts it can be rebuilt from the events.

## Alternatives considered

**Record only executed actions.** Smaller, simpler, and it destroys the evidence for the
project's central claim. Rejected.

**Soft-delete flags / status field updated in place.** Mutable by definition. An audit record
whose status can be rewritten proves nothing about what happened. Rejected.

**Write audit to log files or a log aggregator only.** Cheap and genuinely append-only, but not
queryable in the way FR-11 requires, not tenant-scoped, and it separates the evidence from the
data it describes. Rejected as the primary store; structured logs still carry correlation ids
alongside.

**Hard-delete audit records on a deletion request.** Maximally respectful of the deletion right
and it deletes the proof of the invariant. Rejected in favour of de-identification, with the
trade-off stated openly rather than hidden.

## Amendments

**2026-09-08 (Phase 3) — two refinements from designing the fields.**

**1. `ActionExecution` is renamed `ActionOutcome`**, for the reason given in
[ADR 0003](0003-recheck-at-execution-and-idempotency.md#amendments): it records refusals too.

**2. De-identification scrubs the `Customer` document; it never rewrites an audit row.** This
ADR said audit records are "retained with the subject de-identified", which read as though the
immutable rows would be edited — contradicting the immutability this same ADR requires. The
actual mechanism: audit rows hold a `customerId` reference and **no free text**; deletion
scrubs the `Customer` document in place, leaving an opaque id that resolves to a profile
containing no personal data. The decision structure survives untouched and immutability is
never violated.

This forces a schema constraint worth stating plainly: **audit records store evidence
*references*, never snippets.** A copied-in snippet would be free text inside an immutable row,
which is precisely the thing that cannot later be scrubbed. See
[Phase 3](../phases/phase-03-database-design.md) §7.

**2026-09-14 (Phase 10) — malformed attempts are recorded, as codes.** "Every proposal is
persisted" could not be honoured for a proposal too malformed to resolve, because Phase 3
required `target.orderId` unconditionally. `ActionProposal` now has a `validity` field and
requires the resolved fields only when resolved.

The reasons a proposal was malformed are stored as **enumerated codes, never as messages**. The
messages echo model-supplied text — an unknown field name, an order number — and free text in an
immutable row can never be scrubbed. The same rule applies to execution faults, which store an
error code and no driver message. An attempt to assert authorisation (`authorised: true` and
similar) has its own code, so the audit can count those attempts on their own. See
[Phase 10](../phases/phase-10-the-core.md) §4.

## Verified by

- Test: `ActionProposal`, `ActionOutcome`, `TicketEvent` reject every update path.
- Test: a proposal refused by policy is present in the audit query with its refusing rule.
- Test: `GET /api/audit` includes refusals with no filter supplied.
- Test: after de-identification the decision structure survives and the subject does not.
- Test: `Ticket.currentStatus` can be rebuilt from `TicketEvent` and matches.
