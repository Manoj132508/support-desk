# Phase 2 — Architecture

**Project 3 · AI Support Desk**
Status: complete. Decisions are recorded in [`../adr/`](../adr/README.md); this document is the
system view that ties them together.

---

## 1. What Phase 2 settled

| Question | Answer | Where |
|---|---|---|
| Where does the trust boundary sit? | At the Node/Python process boundary | [ADR 0002](../adr/0002-llm-proposes-never-authorises.md) |
| How is an authorisation kept true over time? | Evaluate twice; idempotent execution | [ADR 0003](../adr/0003-recheck-at-execution-and-idempotency.md) |
| Where do policy rules live? | Database; pure evaluator; deny by default | [ADR 0004](../adr/0004-policy-as-data.md) |
| How is tenancy enforced? | In the query shape; 404 never 403 | [ADR 0005](../adr/0005-tenancy-by-query-shape.md) |
| What does the audit keep? | Everything, including refusals; append-only | [ADR 0006](../adr/0006-append-only-audit-retains-refusals.md) |
| **Phase 1 open question 3** — how much refusal reason does a customer see? | **Two channels: static customer text, separate internal detail. Neither model-generated.** | [ADR 0007](../adr/0007-two-channel-refusal-reasons.md) |

Open questions 1 (confirmation modal vs inline) and 2 (policy rules per-tenant vs global) remain
scheduled for Phases 4 and 3 respectively, as planned.

---

## 2. Component and trust view

```
                    ┌───────────────────────────────────────────┐
                    │  TRUSTED — owns everything consequential   │
   browser          │                                            │
 ┌──────────┐  https │  ┌──────────────────────────────────────┐ │
 │  React   │───────────▶│      Express API  (4400)             │ │
 │  (5179)  │◀───SSE────│                                       │ │
 └──────────┘        │  │  auth · tenancy · ticket state machine│ │
                     │  │  ▸ POLICY ENGINE  (pure, no I/O)      │ │
                     │  │  ▸ ACTION EXECUTION                   │ │
                     │  │  ▸ APPEND-ONLY AUDIT                  │ │
                     │  └───────┬───────────────────┬──────────┘ │
                     │          │ read/write        │            │
                     │     ┌────▼─────┐             │            │
                     │     │ MongoDB  │             │            │
                     │     └──────────┘             │            │
                     └──────────────────────────────┼────────────┘
                                                    │ advice only
                            ╔═══════════════════════▼════════════╗
                            ║  UNTRUSTED — advisory, no writes   ║
                            ║   FastAPI AI service  (8200)       ║
                            ║   not publicly routable            ║
                            ║   retrieval · intent · drafting    ║
                            ║   escalation signal · PROPOSAL     ║
                            ║        │            │              ║
                            ║   ┌────▼───┐   ┌────▼────┐         ║
                            ║   │KB index│   │  LLM    │         ║
                            ║   │(read)  │   │ (Ollama)│         ║
                            ║   └────────┘   └─────────┘         ║
                            ╚════════════════════════════════════╝
```

The double line is the invariant. Calling the AI service **untrusted** is not a comment on code
quality — it is the design stance that makes INV-A hold regardless of what happens inside it.
Anything crossing upward is a *request*.

**What the AI service cannot do, by construction:** reach the browser directly, hold a
credential that writes business collections, supply its own tenant id, or cause a mutation
without a policy decision and a human confirmation above it.

---

## 3. Request flows

### 3.1 Informational turn — no consequences

```
customer message
   │
   ├─▶ Express: authenticate, tenant-scope, persist user turn, open SSE
   │
   ├─▶ AI service: retrieve KB evidence → draft answer
   │
   ├─◀ tokens stream back ──▶ client renders progressively
   │
   └─▶ persist assistant turn + citations; close stream

   retrieval below threshold ──▶ honest refusal (INV-C) ──▶ offer escalation
```

Nothing here is new. This is Project 1's path with Project 2's auth around it, and the README
says so.

### 3.2 Action turn — the project

```
"cancel my order 1043"
   │
   ├─▶ Express: authenticate, tenant-scope, persist turn
   │
   ├─▶ AI service: resolve intent, look up order via read-only tool,
   │               emit ActionProposal { type, orderId, evidence }
   │               ── executes nothing ──
   │
   ├─▶ Express boundary:
   │      1. VALIDATE SHAPE   malformed / unresolved / cross-tenant → reject + record
   │      2. PERSIST proposal (before any decision — ADR 0006)
   │      3. EVALUATE POLICY  (pure fn; deny by default — ADR 0004)
   │             ├─ agent-only      → record → escalate → ticket
   │             ├─ refused         → record → customerMessage (ADR 0007) → escalate
   │             └─ confirm-required→ continue
   │      4. RENDER CONFIRMATION from the stored proposal, not from model text
   │
   ├─ ⏸ customer decides ──── reject → record → escalate ────────────┐
   │      │ confirm                                                   │
   ├─▶ POST /api/proposals/:id/confirm   (the ONLY mutating route)    │
   │      5. RE-EVALUATE POLICY against the world as it is NOW        │
   │             └─ now refused → record BOTH decisions → explain → escalate
   │      6. EXECUTE inside a transaction, keyed by idempotency key
   │             duplicate → return the original result, unchanged
   │      7. APPEND ActionExecution: proposal ref, both decisions,
   │                confirmation, key, outcome, timestamps
   │
   └─▶ confirm the outcome to the customer                            │
                                                                      ▼
                                          every branch ends in a record and a next step
```

Read the diagram for what it refuses to do. The model appears once, at the top, and never
again. Steps 3 through 7 contain no inference. Every terminal branch writes a record and offers
the customer somewhere to go — a refusal that dead-ends is a product bug (ADR 0007).

---

## 4. Failure modes

Designed now, because "what happens when the AI service is down" answered in Phase 14 is
answered too late.

| Failure | Behaviour | Requirement |
|---|---|---|
| AI service down or timing out | Tickets, history, console, audit all keep working. New assistant turns are unavailable and **the UI says so plainly** — no spinner that never resolves | FR-14.3, NFR-5 |
| AI service returns a malformed proposal | Rejected at the boundary, recorded as malformed, escalated. Policy never sees it | ADR 0002 |
| Policy rules fail to load | **Fail closed** — every action is `agent-only`. The desk degrades to human-only, never to permissive | ADR 0004 |
| MongoDB unavailable | Hard failure with a clear error. Nothing is executed without an audit record, so a system that cannot write audit must not act | INV-B |
| Execution succeeds, audit write fails | Impossible by construction: both are in one transaction and roll back together | INV-B |
| Duplicate / retried confirmation | Returns the original result. Unique index on the idempotency key is the enforcement | ADR 0003 |
| Order state changes mid-flight | Refused at execution, both decisions recorded, customer told, escalated | ADR 0003 |
| LLM produces prompt-injected instructions | Worst case is a refused proposal and an audit row | ADR 0002 |

The pattern: **every degradation moves toward doing less, never toward doing more.**

---

## 5. Cross-cutting concerns

**Correlation ids.** Express mints a request id, propagates it to the AI service in a header,
and both tiers log it in structured JSON. One id reconstructs a full turn across the process
boundary — otherwise the boundary that provides the safety also destroys the debuggability
(NFR-8).

**Error taxonomy.** Four kinds, deliberately distinguished because they mean different things
and belong to different owners:

| Kind | Example | Customer sees | Recorded as audit? |
|---|---|---|---|
| `malformed` | Unresolved proposal target | Generic + escalation | Yes |
| `refused` | Policy said no | `customerMessage` + next step | **Yes** |
| `stale` | Refused at execution | "No longer possible" + reason | **Yes** |
| `fault` | Database down, AI service unreachable | Generic error | No — logged, not audited |

The first three are *normal outcomes* of a working system. Only `fault` is a bug. Collapsing
refusals into a generic error state is the most likely way for a UI to quietly undermine the
project's central claim, so the taxonomy is fixed here in Phase 2, before the UI exists.

**Configuration and secrets.** Every secret via environment variable, never committed;
`.env.example` documents required names with no values. The AI service's database credential is
**read-only on the KB and has no access to business collections** — this is configuration that
enforces an invariant, so it is tested, not just documented.

**Data ownership.** Express owns all business collections. The AI service owns only the KB index
and reads it. No shared writable state, no queue between them — the call is synchronous and the
proposal is a return value, which keeps the trust boundary a single, visible line.

---

## 6. Deployment topology

Four services under Docker Compose (Phase 15): client, api, ai-service, mongo. Only client and
api publish ports; ai-service and mongo are internal to the compose network.

Per NFR-7 and honestly stated in the README: Docker is not installed on this machine, so the
compose file and images are **authored and their inputs verified, but not built here**.

---

## 7. What Phase 2 deliberately did not decide

- **Collection schemas and indexes** — Phase 3. This document names entities and relationships;
  it does not fix field types.
- **Confirmation UI: modal or inline** — Phase 4 (open question 1). Still leaning modal.
- **Policy rules per-tenant or global** — Phase 3 (open question 2). Still leaning per-tenant.
- **The condition vocabulary** for policy rules — Phase 3, alongside the `PolicyRule` schema.
- **Retention windows for audit data** — future work, and named as such in ADR 0006 rather than
  quietly omitted.

---

*Phase 2 complete. Phase 3 designs the database: the ten entities behind FR-4…FR-9, the
`immutablePlugin` application from ADR 0006, the `PolicyRule` schema and condition vocabulary
from ADR 0004, and open question 2.*
