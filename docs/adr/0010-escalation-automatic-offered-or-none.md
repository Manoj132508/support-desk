# ADR 0010 — Escalation is automatic, offered, or absent, and only the deterministic tier escalates on its own

- **Status:** Accepted
- **Date:** 2026-09-15 (Phase 11)
- **Satisfies:** FR-8 · **Supports:** INV-A, INV-B
- **Relates to:** [ADR 0002](0002-llm-proposes-never-authorises.md),
  [ADR 0003](0003-recheck-at-execution-and-idempotency.md),
  [ADR 0004](0004-policy-as-data.md), [ADR 0007](0007-two-channel-refusal-reasons.md)

## Context

Four earlier documents say when a conversation reaches a person, and they do not agree.

- **FR-8.2** names three triggers: an `agent-only` policy decision, low retrieval confidence, and an
  explicit customer request. Its acceptance test: an `agent-only` decision *always* produces an
  escalation and never a dead end.
- **Phase 2 §3.2** draws "escalate" after `agent-only`, after a refusal, after the customer
  *rejects* a proposal, and after a refusal at execution. Its failure table escalates malformed
  proposals too. Its §3.1 only *offers* escalation when retrieval falls below threshold.
- **Phase 4 §5** has refused, stale and malformed blocks *offer* escalation.
- **ADR 0007** says a rule with no customer message falls back to generic text — "Let me bring in
  a colleague who can help" — **and escalates**.

Taken literally together they cannot all hold. Escalating every refusal fills the queue with cases
no person can change: Phase 3 split `refuse` from `agent-only` precisely because "nobody may" and
"a human may" call for opposite handling. Escalating a rejection turns the customer's own decision
into work. And *offering* a person after the customer has already read "I'll bring in a colleague"
— the text of the baseline rule for dispatched orders — breaks a promise the product already makes
(Phase 10 §14).

One more case surfaced while this was being decided. When execution fails with a fault, the action
service records a terminal `failed` outcome, and its comment says why: *"so an agent looks rather
than the proposal silently hanging."* Nothing made an agent look. And because the outcome is
terminal, the customer cannot retry either.

## Decision

**Every situation falls into exactly one of three cases.**

| Case | When | Recorded reason |
|---|---|---|
| **Automatic** — Express creates or updates the ticket itself | A policy decision of `agent-only`, at proposal or at execution, including deny-by-default and fail-closed | `policy_agent_only` |
| | A proposal the boundary could not accept: nothing was decided at all | `proposal_malformed` |
| | A refusal whose rule has no customer message: ADR 0007's fallback promises a colleague | `policy_refused` |
| | An execution fault recorded as a terminal `failed` outcome: the customer can no longer retry | `execution_failed` |
| **Offered** — the customer sees "Talk to a person" and decides | A refusal carrying the rule's own customer message, at proposal or at execution | `policy_refused`, when accepted |
| | An answer the AI service marked `shouldEscalate` | `customer_request`, when accepted |
| | Any other point in a conversation | `customer_request` |
| **None** | The customer's own decisions: `executed`, `rejected_by_customer`. An `expired` proposal. States that are not policy decisions and that the customer can retry: already decided, the order changed, a fault that recorded nothing | — |

**The rule underneath: only the deterministic tier escalates on its own.** Automatic escalation
follows from what Express's boundary, policy engine and executor recorded. The AI service's
`shouldEscalate` is advisory, like everything else it produces: it can put an *offer* in front of
the customer, who decides, but it never creates a ticket. This is ADR 0002's shape again. The
advisory tier proposes an escalation; the customer or the policy engine authorises it. Otherwise
the retrieval threshold would have a direct lever on the agent queue, and every off-topic question
would become work for a person.

**An automatic escalation commits with the record that caused it.** The outcome row — or, for a
malformed proposal, the proposal row — and the ticket write share one transaction. No record that
escalates exists without its ticket, and the customer is told a colleague is coming only after the
ticket exists.

**"Creates or updates a ticket" (FR-8.3) means at most one active ticket per conversation**,
enforced by a partial unique index rather than by a read before the write. Escalating onto an
active ticket appends an `escalated` event. A ticket that was `waiting` or `resolved` returns to
`assigned`, because a customer asking for a person again needs someone's attention. A `closed`
ticket is settled; the next escalation opens a new one.

**An accepted offer's reason is derived by the server, never taken from the client.** "Talk to a
person" pressed on a refusal sends the proposal's id; the server records `policy_refused` only if
that proposal belongs to this customer's conversation and was in fact refused. Anything else is
`customer_request`.

## Consequences

**Positive**

- Every sentence that promises a colleague is backed by a ticket that already exists.
- The queue holds cases a person can act on or must explain, not decisions nobody can change.
- The automatic cases are a pure function of what was recorded, tested exhaustively.
- The advisory tier gains no write path, into the queue or anywhere else.

**Negative**

- A customer refused with a clear message who still wants a person has to press a button.
  Accepted: the message states the reason, and often the alternative.
- A low-confidence answer reaches the queue only if the customer asks. Customers who leave after
  the offer are exactly what the wrongful-deflection rate (Phase 13) counts, so the cost of this
  choice is measured rather than hidden.
- Automatic escalation needs a transaction across the audit record, `Ticket` and `TicketEvent`.
  The replica set it requires is already required by ADR 0003.

**Neutral**

- `TicketEvent.reason` gains `proposal_malformed` and `execution_failed`. `low_confidence` stays in
  the enum, unused, because the server has no verified fact to record it from.
- Phase 2 §3.2's arrows from a refusal and from a rejection are corrected by this ADR rather than
  edited in place.

## Alternatives considered

**Escalate every refusal and rejection automatically**, as Phase 2 §3.2 draws. Rejected: it fills
the queue with decisions no person can change, and it treats a customer's rejection as a failure.

**Only ever offer.** Rejected: it fails FR-8's acceptance test, and it breaks the promise the
dispatched-order rule's own text makes.

**Soften the promising copy instead of creating the ticket.** Rejected in Phase 10 §14: a person is
the promise the product should keep.

**Escalate automatically on `shouldEscalate`.** Rejected: it hands the advisory tier a write into
the agent queue.

## Verified by

- Test: every policy outcome, and a malformed proposal, maps to its case in the table above.
- Test: no input to the automatic rule produces `customer_request` or `low_confidence`.
- Test: escalating with no active ticket creates one; onto `waiting` or `resolved` it returns to
  `assigned`; every such move is legal in the state machine.
- Test: an automatic escalation and the record that caused it are written in one session.
- Test: a terminal execution failure escalates; a fault that recorded nothing does not.
- Test: a customer's escalation citing someone else's proposal, or one that was not refused, is
  recorded as `customer_request`.
