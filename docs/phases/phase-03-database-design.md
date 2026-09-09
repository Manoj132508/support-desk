# Phase 3 — Database design

**Project 3 · AI Support Desk**
Status: complete. Implements the entities behind FR-4…FR-9 and INV-B, the `PolicyRule` model
from [ADR 0004](../adr/0004-policy-as-data.md), and answers Phase 1 open question 2 via
[ADR 0008](../adr/0008-policy-rules-tenant-scoped-with-global-baseline.md).

---

## 1. What Phase 3 settled

| Question | Answer | § |
|---|---|---|
| **Phase 1 open question 2** — policy rules per-tenant or global? | **Tenant rules layered over a version-controlled global baseline** ([ADR 0008](../adr/0008-policy-rules-tenant-scoped-with-global-baseline.md)) | 5 |
| Are customers and staff the same entity? | One `User` for authentication, a separate `Customer` for the commerce subject | 3 |
| How is a rule outcome expressed? | One ordered field, four values, most restrictive wins | 5 |
| How does deletion coexist with an immutable audit? | Scrub the `Customer`; never rewrite an audit row | 7 |
| What enforces once-only execution? | A unique index, not application logic | 8 |

It also produced **three corrections to earlier phases**, recorded as ADR amendments rather
than applied silently — §2.1.

---

## 2. Collection map

Eleven collections. Phase 1 listed ten entities; `Tenant` was missing and is added here.

```
Tenant
  ├── User ──────────────┐  (agent · lead · admin · customer)
  │      │               │
  │      └── Customer ◀──┘  1:1 for role=customer; the commerce subject
  │             │
  │             ├── Order                    seeded demo records
  │             │
  │             └── Conversation
  │                    ├── Message
  │                    ├── Ticket ── TicketEvent          ▲ append-only
  │                    └── ActionProposal                 ▲ append-only
  │                             └── ActionOutcome         ▲ append-only
  │
  └── PolicyRule        tenant rules + baseline (tenantId: null)
```

The three marked collections are immutable (`immutablePlugin`, ported from Project 2). The KB
index is **not** here — it is owned by the AI service (ADR 0001, "no shared writable state").
Citations reference chunk ids as opaque strings, and nothing in MongoDB depends on the index's
shape.

### 2.1 Corrections to earlier phases

Designing fields is where design errors surface. Three did:

| Correction | Where recorded |
|---|---|
| `ActionExecution` → **`ActionOutcome`**. It is written for every terminal state, including refusals. A collection named "execution" full of non-executions misleads its readers | [ADR 0003 amendment](../adr/0003-recheck-at-execution-and-idempotency.md#amendments) |
| Three tiers → **four-outcome ladder**. `agent-only` and `refuse` are not the same, and collapsing them would tell an agent they may do something they may not | [ADR 0004 amendment](../adr/0004-policy-as-data.md#amendments) |
| De-identification **scrubs `Customer`**, never rewrites audit rows — ADR 0006's original wording contradicted its own immutability rule | [ADR 0006 amendment](../adr/0006-append-only-audit-retains-refusals.md#amendments) |

---

## 3. Identity: `User` and `Customer`

Phase 1 pulled in two directions. FR-13.2 lists `customer` among the *roles*, implying one
collection. The brief's entity list has `User` **and** `Customer`, implying two.

**Both are right, because they answer different questions.** Authentication is identical for all
four roles — email, password hash, session, CSRF, all ported from Project 2. The *commerce
subject* is not: orders belong to it, conversations are about it, and audit rows point at it.
Staff have no orders.

```js
Tenant {
  _id, name, slug,                       // slug unique
  createdAt
}

User {                                   // authentication, all roles
  _id, tenantId,
  email, passwordHash, name,
  role,                                  // 'customer' | 'agent' | 'lead' | 'admin'
  customerId,                            // set iff role === 'customer'
  status,                                // 'active' | 'disabled'
  createdAt, updatedAt
}

Customer {                               // the commerce subject
  _id, tenantId,
  externalRef,                           // id in the seeded commerce data
  displayName, email,                    // scrubbed on de-identification
  deidentifiedAt,                        // null until deletion
  createdAt, updatedAt
}
```

The separation earns its keep in §7: deletion scrubs `Customer` and deletes the `User`, while
every audit row keeps pointing at a `Customer` `_id` that no longer resolves to a person. A
single merged collection would force deletion to choose between breaking auth and breaking the
audit trail.

*Alternative considered:* one `User` with optional commerce fields. Simpler, and it makes
de-identification a partial-field surgery on a document that also holds credentials — mixing
the thing that must be deleted with the thing that must survive.

---

## 4. The audit spine

Two collections, both immutable. `ActionProposal` records **what was asked**; `ActionOutcome`
records **how it ended**.

```js
ActionProposal {                         // IMMUTABLE — written before any evaluation
  _id, tenantId,
  conversationId, messageId, customerId,
  actionType,                            // 'order.cancel'  (MVP: the only one)
  target: { kind: 'order', orderId, orderNumber },
  resolvedArgs: { reasonCode },          // fully resolved — no placeholders (ADR 0002)
  evidence: [                            // REFERENCES ONLY, never snippets (§7)
    { kind: 'kb_chunk' | 'tool_result', ref, messageId }
  ],
  model: { name, promptVersion, latencyMs },
  correlationId,
  createdAt
}

ActionOutcome {                          // IMMUTABLE — one per proposal, terminal
  _id, tenantId, proposalId,
  outcome,                               // see ladder below
  decisionAtProposal:  { ruleId, ruleKey, ruleVersion, outcome, matched: [...] },
  decisionAtExecution: { ruleId, ruleKey, ruleVersion, outcome, matched: [...] } | null,
  confirmation: { userId, at, confirmedText } | null,
  idempotencyKey,                        // derived from proposalId — UNIQUE index
  result: { orderVersionBefore, orderVersionAfter, cancellationRef } | null,
  error: { code, message } | null,
  createdAt
}
```

`outcome` is one of:

| Value | Meaning | Mutation occurred |
|---|---|---|
| `refused_at_proposal` | Policy said no before the customer saw anything | no |
| `escalated_at_proposal` | `agent-only` — handed to a human | no |
| `rejected_by_customer` | Confirmation declined | no |
| `expired` | Never decided; swept by the hygiene job *(added in [Phase 4](phase-04-ui-ux.md) — dismissing a confirmation leaves the proposal pending, so "not decided" needed a terminal state distinct from "declined")* | no |
| `refused_at_execution` | Authorised, then no longer valid (ADR 0003) | no |
| `executed` | Done | **yes** |
| `failed` | Attempted, errored, rolled back | no |

Three consequences of this shape:

**A proposal with no outcome row is "pending confirmation".** State is derived from existence,
not stored in a mutable field — which is what lets both collections be immutable. An abandoned
proposal (server restarted mid-flight) is simply one that never got an outcome, and is
distinguishable from a pending one by age.

**Both policy decisions are stored side by side**, so "authorised, then refused" is legible
after the fact. `decisionAtExecution` is null for outcomes that never reached execution.

**`confirmedText` stores the exact string shown to the customer.** FR-6 requires the
confirmation to be rendered from the proposal rather than from model output; storing what was
displayed is how that becomes provable rather than merely intended.

*Alternative considered:* a separate `PolicyDecision` collection, one row per evaluation.
Rejected — ADR 0003 already committed to storing both decisions on one record, and a policy
decision divorced from its proposal is not independently meaningful. Two collections would
fragment the audit for no query anyone needs.

---

## 5. `PolicyRule` — the schema the project turns on

```js
PolicyRule {                             // versions are immutable; edits append
  _id,
  tenantId,                              // null ⇒ platform baseline (ADR 0008)
  ruleKey,                               // stable across versions: 'POL-CANCEL-DISPATCHED'
  version,                               // integer, 1-based
  active,                                // exactly one active version per (tenantId, ruleKey)
  actionType,                            // 'order.cancel'
  priority,                              // evaluation order; lower first
  conditions: [ { field, op, value } ],  // AND-ed; closed vocabulary below
  outcome,                               // the ladder
  customerMessage,                       // ADR 0007 — plain, no identifiers
  internalReason,                        // ADR 0007 — for console and audit
  createdBy, createdAt
}
```

### 5.1 The outcome ladder

Most permissive first. **Later in the list wins** when rules conflict.

```
auto-execute  <  confirm-required  <  agent-only  <  refuse
```

- `auto-execute` — modelled, unit-tested, **never selected in MVP** (FR-5.4).
- `confirm-required` — the MVP path.
- `agent-only` — the assistant may not; a human may. **The deny-by-default value.**
- `refuse` — must not happen at all, by anyone, through this path.

The ordering is not cosmetic. "More restrictive wins" is implemented as *max index in this
array*, which is what makes ADR 0008's baseline layering safe with no branch in the engine: a
tenant rule can only ever move an outcome further right.

### 5.2 Condition vocabulary — closed, typed, validated on write

Every field is registered with a type and its permitted operators. A condition naming an
unregistered field, or an operator the field's type does not allow, is rejected when the rule is
**saved** — not discovered when it is evaluated.

| Field | Type | Operators | Notes |
|---|---|---|---|
| `order.status` | enum | `eq` `ne` `in` `nin` | `placed · paid · packed · dispatched · delivered · cancelled` |
| `order.ageHours` | int | `lt` `lte` `gt` `gte` | derived at evaluation from `placedAt` |
| `order.totalMinor` | int | `lt` `lte` `gt` `gte` | **minor units** — see §9 |
| `order.currency` | enum | `eq` `in` | |
| `customer.orderCount90d` | int | `lt` `lte` `gt` `gte` | derived; supports "frequent canceller" rules |

Conditions within a rule are **AND**-ed. OR is expressed as two rules — deliberately, because a
rule that reads as one sentence is a rule a support lead can be held to.

The registry is the engine's whole input contract. It is what makes `evaluate()` a total
function over a small, enumerable input space, which is what makes exhaustive testing possible
and the golden set meaningful.

### 5.3 Versioning

Editing a rule inserts a new document with the same `ruleKey`, `version + 1`, `active: true`,
and flips the previous version's `active` to `false`. Old versions are never deleted and never
edited.

`ActionOutcome` stores `ruleId` **and** `ruleKey` **and** `ruleVersion`. The id alone would be
enough to resolve the document, but storing the key and version makes an audit row readable
without a join — which matters when the question is being asked in an incident review.

*Note:* `PolicyRule` is not under `immutablePlugin`, because the `active` flag flips. Versions
are immutable **in content**; the flag is bookkeeping. Named here so the inconsistency reads as
a decision rather than an oversight. A test asserts no field other than `active` ever changes on
an existing version.

---

## 6. Tickets and events

```js
Ticket {
  _id, tenantId, conversationId, customerId,
  currentStatus,                         // DENORMALISED cache of the event stream
  assigneeId, reason, priority,
  openedAt, closedAt, createdAt, updatedAt
}

TicketEvent {                            // IMMUTABLE
  _id, tenantId, ticketId,
  seq,                                   // monotonic per ticket; unique with ticketId
  type,                                  // 'created' | 'assigned' | 'status_changed' | 'note' | 'escalated'
  fromStatus, toStatus,
  actor: { kind: 'system' | 'user' | 'assistant', userId },
  reason, correlationId, createdAt
}
```

The event stream is the source of truth; `Ticket.currentStatus` is a cache that exists so the
queue is one indexed query instead of an aggregation. A test rebuilds `currentStatus` from
`TicketEvent` and asserts it matches (ADR 0006).

`seq` is monotonic per ticket and unique with `ticketId`. It gives deterministic ordering that
`createdAt` cannot — two events in the same millisecond are otherwise unordered — and the unique
index makes concurrent transitions collide loudly instead of interleaving silently.

The legal transitions from FR-9.1 are enforced in the service layer, and an illegal one is
rejected by the server rather than merely hidden in the UI (FR-9.2).

---

## 7. Privacy: how deletion and immutable audit coexist

This is the tension FR-13.4 named and ADR 0006's original wording fudged.

**The mechanism:**

1. `Message` and `Conversation` rows are **deleted** — they carry free text and are not audit.
2. The `User` row is **deleted** — credentials, email, session.
3. The `Customer` document is **scrubbed in place**: `displayName` and `email` nulled,
   `externalRef` nulled, `deidentifiedAt` set. The `_id` survives.
4. **`ActionProposal`, `ActionOutcome` and `TicketEvent` are not touched at all.**

Because audit rows reference `customerId` and hold **no free text**, an audit row after deletion
reads: *a cancellation was proposed for an order in state `dispatched`, and baseline rule
`POL-CANCEL-DISPATCHED` v2 refused it.* The decision structure is intact. The person is gone.

**This forces a schema constraint, and it is the design constraint of the whole section:**
`ActionProposal.evidence` stores **references, never snippets**. A copied-in KB excerpt or
customer sentence would be free text inside an immutable row — unscrubbable by construction, and
the one thing that would make deletion and immutability genuinely irreconcilable. Keeping
evidence by reference is what makes the rest of the design possible.

`TicketEvent.reason` is the residual risk: it is free text, and an agent could type a name into
it. Mitigations: `reason` on assistant- and system-generated events is drawn from an enumerated
set, and agent-authored notes go to a separate mutable `note` field on the ticket rather than
into the immutable event. Stated as a residual risk rather than claimed solved.

---

## 8. Indexes

| Collection | Index | Why |
|---|---|---|
| `ActionOutcome` | `{ idempotencyKey }` **unique** | **Enforces once-only execution (ADR 0003).** The database wins the race an application check would lose |
| `ActionOutcome` | `{ tenantId, createdAt: -1 }` | Audit query, default sort (FR-11) |
| `ActionOutcome` | `{ tenantId, outcome, createdAt: -1 }` | "What was refused this week" — the demo query |
| `ActionOutcome` | `{ proposalId }` **unique** | One outcome per proposal |
| `ActionProposal` | `{ tenantId, conversationId, createdAt: -1 }` | Conversation view |
| `PolicyRule` | `{ tenantId, ruleKey, version }` **unique** | No duplicate versions |
| `PolicyRule` | `{ actionType, active, priority }` | The evaluation load; covers `$in: [tenantId, null]` (ADR 0008) |
| `TicketEvent` | `{ tenantId, ticketId, seq }` **unique** | Ordering + concurrent-transition collision |
| `Ticket` | `{ tenantId, currentStatus, openedAt }` | Agent queue (FR-10.1) |
| `Message` | `{ tenantId, conversationId, createdAt }` | Transcript load |
| `Order` | `{ tenantId, orderNumber }` **unique** | Lookup by the number a customer quotes |
| `Order` | `{ tenantId, customerId, placedAt: -1 }` | "My orders" |
| `User` | `{ tenantId, email }` **unique** | Login |
| `Customer` | `{ tenantId, externalRef }` | Seed linkage |

Every index leads with `tenantId`, which is what makes ADR 0005's query shape fast as well as
correct. The four unique indexes are load-bearing: each enforces an invariant that application
code would otherwise have to remember.

---

## 9. Consistency and correctness rules

**Money is integer minor units.** `totalMinor: 129900` is £1299.00. No floats anywhere near a
currency value, and `currency` is always stored alongside. A float in a policy condition
comparing order value would make rule evaluation non-deterministic across platforms — which
would quietly break the one component whose determinism the project's central claim rests on.

**Timestamps are UTC `Date`.** `order.ageHours` is derived at evaluation, never stored, so a
rule cannot be decided against a stale age.

**Optimistic concurrency on `Order`.** Execution reads `version`, and the cancelling update is
conditional on it being unchanged. Combined with the execution-time policy re-check (ADR 0003),
this closes the gap between *deciding* and *writing* as well as the gap between *proposing* and
*deciding*.

**Execution is one transaction.** The `Order` update, the `ActionOutcome` insert and the
`TicketEvent` insert commit together or not at all. This is what makes ADR 0006's "execution
succeeds, audit write fails" impossible rather than merely unlikely.

> **Environment constraint, surfaced now rather than in Phase 15.** MongoDB multi-document
> transactions require a **replica set**; a standalone `mongod` cannot run them. Development
> therefore needs a single-node replica set (`--replSet rs0` plus `rs.initiate()`), not the
> default standalone install. This is a real setup step that will otherwise fail at Phase 10
> with a confusing error, so it belongs in the README's setup section and in the compose file.

---

## 10. Seed data

The demo is only evidence if a reviewer can reproduce it (Phase 1 §8).

- **1 tenant**, plus a second used solely to prove tenant isolation (INV-D).
- **Users** for each role, credentials documented in the README as demo-only.
- **Customers** with linked `User` rows.
- **Orders covering every status**, so each policy condition is exercised by real data —
  including a `dispatched` order (the interesting refusal) and a `delivered` one (the `refuse`
  outcome).
- **Baseline `PolicyRule` set**, version-controlled and shipped with the repo (ADR 0008), plus a
  small tenant rule set demonstrating layering.
- **KB documents** for the retrieval path.

An order pair is seeded specifically so the ADR 0003 demo works: one order that can be cancelled,
and one whose status the seed script can flip to `dispatched` mid-flight to trigger a genuine
refusal at execution.

---

## 11. What Phase 3 did not decide

- **Mongoose schema code** — Phase 7. This is the design; the models are written when the
  database is integrated.
- **The confirmation UI, modal or inline** — Phase 4, open question 1. Still leaning modal.
- **Audit retention windows** — still future work (ADR 0006).
- **Rule condition vocabulary beyond `order.cancel`** — a schema change when a second action
  arrives, not an architecture change.
- **Whether `customer.orderCount90d` is computed live or cached** — Phase 10, a performance
  question with no correctness content.

---

*Phase 3 complete. Phase 4 designs UI/UX: the conversation view, the confirmation surface
(open question 1), the agent console, and the four error states from
[Phase 2](phase-02-architecture.md) §5 — with the accessibility requirement from NFR-8 that the
confirmation dialog be fully operable without a mouse.*
