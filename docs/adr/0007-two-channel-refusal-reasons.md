# ADR 0007 — Two-channel refusal reasons: customer-facing and internal

- **Status:** Accepted
- **Date:** 2026-09-08 (Phase 2)
- **Answers:** Phase 1 open question 3 · **Satisfies:** FR-5.5, FR-10.3
- **Relates to:** [ADR 0004](0004-policy-as-data.md),
  [ADR 0006](0006-append-only-audit-retains-refusals.md)

## Context

Phase 1 left this open: when policy blocks an action, how much does the customer see?

Both extremes are wrong.

**Show everything.** "Refused by rule `POL-CANCEL-007` v2: `order.status == 'dispatched'`."
Precise, and it hands out the policy boundary. Someone who wants to cancel a dispatched order
now knows exactly which condition to work around, and rule ids and versions are internal
structure a customer has no use for.

**Show nothing.** "Sorry, I can't do that." The customer does not learn whether to wait, retry,
phone, or give up, so they retry — and the support cost the assistant was meant to remove comes
back as repeat contacts.

There is a third option that looks attractive and is the most dangerous: **let the model phrase
the refusal.** Give it the policy decision and ask for a friendly explanation. It reads best of
the three, and it reintroduces exactly the coupling ADR 0002 removed — the customer's
understanding of an authorisation decision would come from a probabilistic component that may
soften, hedge, or misstate it. A model that says "it looks like I can't cancel this right now,
but let me try again" about a hard policy refusal has misrepresented a safety control.

## Decision

**Every `PolicyRule` carries two reason fields, both authored by the rule's author.**

| Field | Audience | Contains | Never contains |
|---|---|---|---|
| `customerMessage` | Customer | Plain-language reason and what to do next | Rule ids, versions, condition expressions, internal field names |
| `internalReason` | Agent console, audit log | Rule id, version, matched conditions, evaluated world state | — |

The customer sees `customerMessage`. The agent console and audit log see both (FR-10.3 — a
blocked action is shown *with the rule that blocked it*).

**Neither string is model-generated.** Both are static text on the rule, rendered directly. The
refusal a customer reads is written by the person who wrote the rule, which is the same person
accountable for the policy.

**Fallback is generic, never internal.** A rule with a missing or empty `customerMessage` falls
back to a fixed generic message — *"I'm not able to do that automatically. Let me bring in a
colleague who can help."* — and **escalates**. It never falls back to `internalReason`. A
missing field must not become a leak, and the fallback is asserted by a test rather than left
to reviewer discipline.

**A refusal always offers a next step.** Every customer-facing refusal ends in either an
escalation or a concrete alternative. A refusal that dead-ends is a product bug, not a safety
success (FR-8.3).

**This applies to refusals at execution time too** (ADR 0003). "This is no longer possible
because the order has now shipped" uses the same two-channel structure, with the same
guarantees.

## Consequences

**Positive**

- The policy boundary is not enumerable from customer-facing text.
- Rule authors are made to think about the human on the other end at authoring time. Writing
  the customer message *is* part of writing the rule.
- Refusal wording is deterministic, testable, and reviewable — it can be checked in CI like any
  other string, which model-generated text cannot.
- The agent sees the full picture and can act on it.

**Negative**

- Two strings per rule instead of zero. Real authoring burden, and the reason the fallback
  exists.
- Static text is less fluent and less context-sensitive than model-generated text. Accepted:
  for a refusal, predictability beats fluency.
- Customer messages need review for tone, which is a small editorial process nobody owns yet.

**Neutral**

- The *conversational framing* around the refusal — the assistant's surrounding turn — may
  still be model-generated. The refusal sentence itself is not, and is rendered as a distinct
  UI element so it cannot be visually confused with model prose.

## Alternatives considered

**Single reason field, redacted for customers.** Strip ids with a regex before display.
Rejected: redaction is a filter that can fail open, and one missed pattern is a leak. Two
fields cannot fail that way.

**Model-generated refusal text.** Rejected in Context — it puts the model back in the position
of communicating an authorisation decision it is not allowed to make.

**Show the rule id to authenticated customers only.** Rejected: the customer is the party the
rule constrains, so authentication does not make them a safe audience for it.

## Verified by

- Test: a rule with no `customerMessage` produces the generic fallback and escalates.
- Test: no customer-facing refusal response contains a rule id, version, or condition
  expression (asserted across the whole seeded rule set).
- Test: the agent console renders both channels for a blocked action.
- Test: a refusal at execution time uses the same structure as one at proposal time.
