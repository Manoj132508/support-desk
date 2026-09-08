# ADR 0003 — Authorisation is re-checked at execution, and execution is idempotent

- **Status:** Accepted
- **Date:** 2026-09-08 (Phase 2)
- **Enforces:** INV-E
- **Relates to:** [ADR 0002](0002-llm-proposes-never-authorises.md),
  [ADR 0006](0006-append-only-audit-retains-refusals.md)

## Context

ADR 0002 puts a policy check between the model's proposal and execution. That check happens at
**proposal time**. Then the proposal is shown to the customer, and the system waits.

That wait is the problem. Between "policy said yes" and the customer clicking **Confirm**,
seconds or minutes pass, and the world moves:

- The order **ships**. Cancelling a dispatched order is exactly what the rule was written to
  prevent, and the rule already said yes.
- An admin **edits the rule** (FR-12 makes policy editable without redeploy). The decision was
  made under a rule that no longer exists.
- The order is cancelled by **another path** — a second browser tab, an agent in the console.
- The customer's **session or role changes**.

Storing "authorised: true" at proposal time and trusting it at confirmation time is a
**time-of-check to time-of-use (TOCTOU)** bug. The check was honest when it ran. It simply
stopped being true, and nothing re-asked.

There is a second, independent problem at the same moment. A confirmation is an HTTP request,
and HTTP requests get retried — a double-click, a flaky connection, a client retry, a user
hitting back and re-submitting. Without protection, one authorisation becomes two executions.

## Decision

**Two decisions, both recorded.**

Policy is evaluated **twice**: once when the proposal arrives (to decide whether to show a
confirmation at all), and again **inside the execution transaction**, immediately before the
mutation. Both decisions are stored on the `ActionExecution` record. An action executes only if
*both* say yes.

The second evaluation reads the world as it is *now* — current order status, current rule
version — not the snapshot from proposal time.

**Execution is idempotent**, keyed by the proposal.

- The idempotency key is derived from the proposal id. One proposal executes **at most once**,
  ever.
- A unique index on `ActionExecution.idempotencyKey` makes this a database guarantee, not an
  application check. Two concurrent confirmations race; one inserts, the other hits the unique
  violation and reads back the winner's result.
- A duplicate confirmation returns the **original result**, with the original timestamp. It is
  not an error — the caller asked for the action to have happened, and it has.

**A late refusal is a first-class outcome, not an exception.** When the second evaluation says
no, the response tells the customer the action is no longer possible and why (ADR 0007), the
refusal is recorded like any other (ADR 0006), and the conversation escalates rather than
dead-ends. The UI must render this state; it is not an edge case to be swept into a generic
error toast.

## Consequences

**Positive**

- Closes the TOCTOU window completely rather than narrowing it.
- Rule edits take effect on in-flight proposals, which is what an admin editing a safety rule
  expects to happen.
- The audit record carries both decisions, so "it was allowed, then it wasn't" is legible after
  the fact. A single stored decision could not express that.
- Retries are safe by construction, which removes a whole class of support incident.

**Negative**

- A customer can be shown a confirmation and then told no. That is a worse experience than
  never offering it — and it is strictly better than wrongly cancelling a shipped order.
- Two evaluations instead of one. Negligible: the engine is pure, in-process, and budgeted at
  under 10 ms (NFR-2).
- The client must handle a third outcome (`refused-at-execution`) alongside success and
  failure.

**Neutral**

- The unique index is the real enforcement. Application-level "have I seen this key" checks are
  a cache in front of it, never a substitute — they lose the race the index wins.

## Alternatives considered

**A short proposal TTL.** Expire proposals after 60 seconds. Rejected: a TTL *narrows* the
window, it never closes it. An order can ship in the 40th second. Choosing a TTL is choosing
how much wrongness to accept, and re-checking costs less than the conversation about what the
number should be. (A TTL may still be added later for hygiene — expiring stale proposals is
reasonable — but as cleanup, never as the safety mechanism.)

**Optimistic execution with compensation.** Execute immediately, undo if it turns out to have
been wrong. Rejected: compensation assumes reversibility. Cancelling a cancellation is not
always possible, refunds are not always re-chargeable, and notification emails are never
un-sent. This project's actions are not safely reversible, which is the whole reason they need
authorising.

**Locking the order at proposal time.** Take a lock when the proposal is created, release on
confirm or timeout. Rejected: it lets a model's speculative proposal block real business
operations — the shipping system cannot dispatch because a chatbot is thinking. The model must
not be able to affect the world before authorisation, and a lock is an effect.

**Idempotency key supplied by the client.** Standard for public payment APIs. Rejected here:
the key would be attacker-controlled, and deriving it from the proposal expresses the actual
rule — *one proposal, one execution* — more directly than trusting a client-supplied string.

## Amendments

**2026-09-08 (Phase 3) — the collection is named `ActionOutcome`, not `ActionExecution`.**
Designing the fields showed that this record is written for *every* terminal state of a
proposal, including ones that never executed — refused at proposal, rejected by the customer,
refused at execution. A collection called `ActionExecution` in which most rows are not
executions misleads every future reader, and the audit log's whole purpose is to be read
correctly. The decision in this ADR is unchanged; only the name is. See
[Phase 3](../phases/phase-03-database-design.md) §4.

## Verified by

- Test: confirming the same proposal twice cancels the order once; the second call returns the
  first result unchanged.
- Test: an order that ships between proposal and confirmation is refused at execution, and both
  policy decisions appear on the audit record.
- Test: a rule edited to forbid the action between proposal and confirmation causes refusal at
  execution.
- Test: two concurrent confirmations produce exactly one `ActionExecution`.
