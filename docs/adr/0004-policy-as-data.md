# ADR 0004 — Policy is data, evaluated by a pure function, deny by default

- **Status:** Accepted
- **Date:** 2026-09-08 (Phase 2)
- **Supports:** INV-A · **Satisfies:** FR-5, FR-12 · **Constrained by:** NFR-2, NFR-6
- **Relates to:** [ADR 0002](0002-llm-proposes-never-authorises.md)

## Context

ADR 0002 puts a deterministic policy check on the action path but does not say where the rules
live. Two forces pull in opposite directions.

Rules as **code** are simple, versioned by git, and impossible to misconfigure at runtime. But
the requirements name a *support lead* who "owns the policy rules deciding what the assistant
may do autonomously" (Phase 1, §2). If a rule change is a deployment, that actor does not
exist, and the project quietly becomes "a developer decided what the bot may do" — a much less
interesting claim.

Rules as **data** make that actor real, but introduce a runtime input that can be wrong.

There is a third force that decides it: the policy eval (§7.2) is the artefact that proves
INV-A. An eval that tests hard-coded constants proves the constants; an eval that runs the real
engine against the real seeded rule set proves the mechanism.

## Decision

**Rules are `PolicyRule` documents. The engine is a pure function.**

```
evaluate(rules, proposal, worldState) → { decision, tier, ruleId, ruleVersion, reasons }
```

Four properties:

**1. The engine performs zero I/O.** Rules and world state are *passed in*, already loaded.
This is a design constraint, not a preference (NFR-6): a policy engine that fetches its own
data cannot be unit-tested without a database, so it will be tested less, and it is the one
component in the system that must be tested most. It also keeps evaluation under 10 ms
(NFR-2) and makes the second evaluation in ADR 0003 essentially free.

**2. Deny by default.** If no rule matches, the decision is **`agent-only`** — escalate to a
human. Never allow. An unmatched proposal means the situation was not anticipated, and an
unanticipated situation is precisely when a human should look. The default is the most
important line in the engine, and it is the first thing the eval asserts.

**3. Rules are versioned; edits never mutate history.** Editing a rule creates a new version.
Every stored decision records `ruleId` **and** `ruleVersion`. A decision made last week remains
explainable against the rule that actually produced it, even after the rule changes (FR-12.2).
This is what makes ADR 0003's "the rule changed between proposal and execution" a legible event
rather than a mystery.

**4. Conditions are a small, closed vocabulary.** Field comparisons over the resolved target —
for cancellation: order status, order age, order value. Enumerated operators, typed operands,
validated on write. Not a scripting language.

**Precedence:** rules are evaluated in explicit priority order; the first match wins, and the
matched rule's identity is returned. When two rules could match, the more restrictive tier
wins — an `agent-only` rule and a `confirm-required` rule matching the same proposal yields
`agent-only`.

## Consequences

**Positive**

- The support lead becomes a real actor, and FR-12 is meaningful.
- The eval exercises the real engine against the real rule set, so it proves the mechanism.
- Rule changes need no deployment, which is what a safety control should allow.
- A pure function is trivial to test exhaustively — hundreds of cases in milliseconds.

**Negative**

- A runtime input that can be wrong. An admin can write a rule that is too permissive.
  Mitigated three ways: deny-by-default limits the damage of a *missing* rule; rule writes are
  schema-validated and audited; and the policy eval runs against the seeded production rule set
  in CI, so a rule that breaks an invariant fails the build.
- Rule authoring is a UI surface to build (Phase 10/11).
- Loading rules on every evaluation is a database read. Mitigated by caching the rule set with
  invalidation on write — the *cache* does I/O, the *engine* does not.

**Neutral**

- The condition vocabulary is deliberately too small for real-world policy. Widening it is
  post-MVP work and is a schema change, not an architecture change.

## Alternatives considered

**Hard-coded rules in TypeScript/JS.** Simplest, safest, fully git-versioned. Rejected: it
deletes the support-lead actor and makes the eval prove less. Reconsidered honestly — this is
the closest alternative, and if the project runs long, freezing the rule *editor* UI while
keeping rules as data is the right cut. The data model stays either way.

**A rules-engine library or DSL** (json-logic, OPA/Rego, a small expression language).
Rejected as over-engineering for three field comparisons. It would also move the invariant into
a dependency, and "the invariant holds because this library is correct" is a weaker sentence
than "the invariant holds because these forty lines are correct and here are their tests."

**Rules expressed as prompts.** Explicitly rejected — it is the failure ADR 0002 exists to
prevent, wearing a configuration hat.

## Amendments

**2026-09-08 (Phase 3) — the three tiers become a four-outcome ladder.** This ADR described a
`decision` plus a `tier` of `auto-execute` / `confirm-required` / `agent-only`. Writing the
`PolicyRule` schema showed the two fields were really one, and that a distinction was missing:
`agent-only` ("the assistant may not, a human may") is not the same as `refuse` ("this must not
happen at all" — cancelling a delivered order). Both stop the assistant, but they give the
agent console entirely different affordances, and collapsing them would tell an agent they may
do something they may not.

The rule outcome is therefore a single ordered field, most permissive first:

```
auto-execute  <  confirm-required  <  agent-only  <  refuse
```

"Deny by default" is unchanged and still resolves to `agent-only` — an unanticipated situation
warrants a human, not a dead end. "More restrictive wins" is now literally *later in this list
wins*, which is what makes [ADR 0008](0008-policy-rules-tenant-scoped-with-global-baseline.md)'s
baseline layering safe without a special case. See
[Phase 3](../phases/phase-03-database-design.md) §5.

## Verified by

- Policy eval golden set, gating CI: unauthorised-action rate 0, over-block rate reported.
- Test: no matching rule yields `agent-only`, never `allow`.
- Test: conflicting rules resolve to the more restrictive tier.
- Test: a decision made under rule v1 still reports v1 after the rule is edited to v2.
- Test: the engine module imports nothing that performs I/O.
