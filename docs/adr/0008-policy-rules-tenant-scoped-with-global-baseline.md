# ADR 0008 — Policy rules are tenant-scoped over a global baseline

- **Status:** Accepted
- **Date:** 2026-09-08 (Phase 3)
- **Answers:** Phase 1 open question 2
- **Relates to:** [ADR 0004](0004-policy-as-data.md), [ADR 0005](0005-tenancy-by-query-shape.md)

## Context

ADR 0004 made policy rules data. Phase 1 left open whether they are global to the deployment or
owned per tenant.

**Global** is simpler: one rule set, one thing to seed, one thing for the eval to run against.
But it contradicts the actor model — Phase 1 §2 names a support lead who "owns the policy rules
deciding what the assistant may do autonomously". If every tenant shares one rule set, that
lead owns nothing, and a lead editing a rule would change behaviour for other tenants. In a
multi-tenant system that is not a limitation, it is a bug.

**Per-tenant** matches the actor model and costs one indexed field. Its risk is different and
worse: a tenant with an empty or misconfigured rule set. Under deny-by-default that fails safe
(everything escalates), but a tenant whose assistant can never act is a broken product, and the
failure is silent — it looks like the assistant is merely cautious.

There is also a class of rule that should not be tenant-editable at all. "Never cancel a
delivered order" is not a business preference; it is a correctness constraint. Letting a tenant
switch it off would let a customer of the platform disable the guarantee the platform makes.

## Decision

**Two layers, evaluated as one ordered set.**

| Layer | `tenantId` | Editable by | Purpose |
|---|---|---|---|
| **Baseline** | `null` | Platform only (seeded, version-controlled) | Constraints no tenant may relax |
| **Tenant** | set | That tenant's lead/admin | Business policy for that tenant |

Evaluation loads the baseline plus the caller's tenant rules, sorts by priority, and applies the
existing precedence: first match wins, and where matches conflict the **more restrictive outcome
wins** (ADR 0004).

That last clause is what makes the layering safe. A tenant rule cannot relax a baseline rule,
because relaxation loses to restriction. A tenant rule can only ever make the assistant *more*
cautious than the platform baseline. This is a property of the precedence rule, not a special
case in the loader — there is no "is this a baseline rule" branch anywhere in the engine.

**Baseline rules are seeded and version-controlled**, not created through the admin UI. They
ship with the repo, which means the policy eval runs against them in CI and a change to a
platform guarantee is a reviewed commit.

**Tenancy of the rules themselves follows ADR 0005** with one deliberate exception: the query
loads `{ tenantId: { $in: [callerTenantId, null] } }`. This is the only place in the system
where a query intentionally reaches outside the caller's tenant, it is read-only, and it is
confined to the rule loader. Called out here so it reads as a decision rather than as an
oversight when someone greps for tenancy violations.

**An empty tenant rule set is legal and safe** — the baseline still applies, and anything the
baseline does not allow escalates. Silence is addressed by making it visible rather than by
changing the semantics: the admin UI shows which rules are baseline and which are the tenant's,
and a tenant with zero rules of its own is stated plainly rather than rendered as an empty
table.

## Consequences

**Positive**

- The support-lead actor is real, and FR-12 means something.
- Platform guarantees cannot be switched off by a tenant.
- The safety property comes from precedence that already existed, so the engine gains no
  branch and stays a pure function.
- Baseline rules live in git, so the eval covers them and changing one requires review.

**Negative**

- The rule loader has two sources, and the `$in: [tenantId, null]` query is a genuine exception
  to ADR 0005 that a reader must be told about — hence this ADR.
- Seeding is more involved: baseline plus per-tenant demo rules.
- A lead can be confused about why a rule they wrote had no effect, when a baseline rule
  out-restricted it. Mitigated by the audit log naming the *deciding* rule, which is exactly
  the information needed to explain it.

**Neutral**

- Whether tenants may ever be granted baseline-editing rights is deferred. Nothing in this
  design forecloses it; it would need its own decision.

## Alternatives considered

**Global rules only.** Simplest, and it deletes the lead actor and breaks multi-tenancy the
moment two tenants disagree. Rejected.

**Per-tenant rules only, no baseline.** Honest multi-tenancy, but every platform guarantee
becomes a copy in every tenant's rule set — drifting, individually editable, and unenforceable.
Rejected: a guarantee that each tenant can delete is not a guarantee.

**Baseline enforced by a separate hard-coded pre-check before the engine.** Would also work, and
splits policy across two mechanisms — some in data, some in code — so "where is the rule that
refused this?" gains a second answer. Rejected in favour of one engine, one rule model, and
precedence doing the work.

## Verified by

- Test: a tenant rule permitting an action the baseline refuses resolves to the baseline's
  refusal.
- Test: a tenant rule *more* restrictive than the baseline wins.
- Test: a tenant with no rules of its own still gets baseline decisions.
- Test: the rule loader is the only query in the codebase that reads outside the caller's
  tenant.
- Policy eval runs against the seeded baseline in CI.
