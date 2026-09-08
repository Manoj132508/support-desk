# Phase 1 — Requirements

**Project 3 · AI Support Desk**
Status: complete. Refines [`../project-brief.md`](../project-brief.md).

---

## 0. How to read this document

The brief argued *why this project should exist*. This document states *what must be true of
the finished system* — precisely enough that a test can be written against each line, and
narrowly enough that we can tell when we are done.

Three kinds of statement appear here, and the difference matters:

| Kind | Prefix | Meaning | If violated |
|---|---|---|---|
| Invariant | `INV-` | Must hold in **every** execution, no exceptions | The system is broken; CI fails |
| Functional requirement | `FR-` | A capability the system must provide | A feature is missing |
| Non-functional requirement | `NFR-` | A quality the system must exhibit | The feature works but the system is not credible |

The distinction is not bureaucracy. Invariants are the ones to defend in an interview, and the
only ones allowed to gate CI. Everything else is scope, and scope can be cut.

---

## 1. Scope

### 1.1 In scope (MVP)

A support desk in which an AI assistant holds a multi-turn conversation with a customer,
answers questions from a help-center knowledge base with citations, looks up real structured
order data, **proposes exactly one kind of side-effecting action (cancel an order)** through a
complete propose → policy → confirm → execute → audit path, escalates to a human when it
should not proceed alone, and records everything it proposed — including what it was refused.

### 1.2 Out of scope, stated explicitly

Naming these now is the cheapest honesty in the project. Each is something an interviewer
might otherwise assume, and being wrong about what a project does is worse than it doing less.

| Excluded | Why |
|---|---|
| Real e-commerce integration | Orders are **seeded demo records**. The README says this in its own words, not in a footnote. |
| Money movement (actual refunds) | A refund that moves money needs a payment processor and a compliance story. The *policy* path generalises to it; the execution does not exist. |
| Additional actions (address change, refund) | Post-MVP. One action done completely is the deliverable; see §6. |
| Email, telephony, voice, social channels | Single web channel. Multi-channel is integration work, not engineering evidence. |
| Multi-language support | English only. |
| Model fine-tuning or training | Provider-neutral inference only. |
| Live agent presence, typing indicators, co-browsing | Real-time collaboration is a separate problem. |
| SSO, SCIM, enterprise provisioning | Local auth ported from Project 2. |
| Autonomy tier `auto-execute` | The policy engine **models** three tiers but MVP wires only two. See FR-5.4. |

### 1.3 Deliberate reuse

Reuse is declared at requirements time so it is never mistaken for original work later.

| Reused from | What | Treated as |
|---|---|---|
| Project 1 | KB ingestion, chunking, embedding, retrieval, grounded-answer prompt, honest refusal | **Ported.** Not re-derived, not claimed as new. |
| Projects 1 & 2 | SSE streaming with client cancellation | Ported. |
| Project 2 | JWT httpOnly cookie + CSRF, tenancy-by-query-shape, deletion cascade, `immutablePlugin`, design tokens and primitives | Ported. |
| Project 2 | Three-tier architecture (ADR 001) | Ported decision, re-affirmed not re-litigated. |

**Everything else is new**, and the new part is FR-4 through FR-7 and FR-11 — the proposal,
policy, confirmation, execution and audit chain.

---

## 2. Actors

| Actor | Authenticated | What they can reach |
|---|---|---|
| **Customer** | Yes (customer session) | Their own conversations and their own orders. Never sees policy rules, evidence internals, or the audit log. |
| **Support agent** | Yes (role `agent`) | The ticket queue for their tenant, conversation history, proposed replies with evidence, blocked actions with the blocking rule. Cannot edit policy. |
| **Support lead / admin** | Yes (role `lead` / `admin`) | Everything an agent can reach, plus policy rule administration and the audit log. |
| **AI service** | Service-internal only | Not publicly routable. Receives conversation context, returns advice. Holds no credentials that permit mutation. |

The AI service is listed as an actor on purpose. Treating it as an untrusted caller — rather
than as part of the backend — is what makes INV-A structural.

---

## 3. Invariants

Each states a property, the mechanism that enforces it, and how it is proven.

### INV-A — No unauthorised action

> The language model may **propose** an action. It may never **authorise** one.
> Every side-effecting action passes a deterministic policy evaluation **and** an explicit
> confirmation of the exact, fully-resolved action before it executes.

- **Enforced by:** the Node/Python trust boundary. The AI service has no write path to
  business data. A proposal crossing into Express is a *request*, and Express may refuse it.
- **Proven by:** the deterministic policy eval (§7.2), which asserts an unauthorised-action
  rate of exactly 0 over a golden set, and gates every PR.
- **Not enforced by:** prompt instructions. If the model's system prompt were deleted, INV-A
  would still hold. That is the test of whether an invariant is architectural.

### INV-B — Complete and immutable audit, including refusals

> Every proposal is recorded, whether it was authorised, refused, confirmed, rejected, or
> executed. Audit records are append-only and never updated in place.

- **Enforced by:** `immutablePlugin` (ported from Project 2) on `ActionProposal`,
  `ActionExecution`, and `TicketEvent`.
- **Why refusals are kept:** what the model tried to do and was stopped from doing is the
  *evidence* INV-A works. Discarding refusals would delete the proof.

### INV-C — Grounded or silent

> An informational answer is derived from retrieved evidence, or the assistant states it does
> not have the information. It does not answer from parametric memory.

Ported from Project 1 along with the retrieval stack.

### INV-D — Tenant isolation by query shape

> A record belonging to another tenant is indistinguishable from a record that does not exist.
> Cross-tenant access returns **404, never 403**.

Ported from Project 2. Tenancy is applied in the query, not as a post-fetch check, so there is
no code path that loads a foreign record and then decides what to do about it.

### INV-E — Authorisation is re-checked at execution, and execution is idempotent

> Policy is evaluated again at execution time, not only at proposal time. Execution is keyed by
> an idempotency key, so a retried confirmation cannot execute twice.

**Why this is separate from INV-A:** time passes between proposal and confirmation. The order
may have shipped; the policy rule may have been edited. An authorisation decision has a shelf
life, and treating it as permanent is the classic time-of-check/time-of-use bug. This is the
most interview-valuable line in the requirements.

---

## 4. Functional requirements

Each requirement carries acceptance criteria written as observable behaviour.

### FR-1 — Customer conversation

1. A customer can start a conversation and send multi-turn messages.
2. Assistant responses stream token by token over SSE.
3. The client can cancel an in-flight response; the server stops generating and persists the
   partial turn as cancelled.
4. Conversation history is persisted and reloadable.

*Accept when:* a reload mid-conversation restores every prior turn in order; a cancelled turn
is visibly marked and never silently completes.

### FR-2 — Grounded answering

1. Informational questions are answered from KB evidence with citations to source chunks.
2. When retrieval returns nothing above the relevance threshold, the assistant refuses honestly
   rather than guessing.
3. Citations resolve to the exact chunk shown to the model.

*Accept when:* a question with no supporting KB content produces a refusal, not an answer.
(INV-C)

### FR-3 — Read-only tools

1. The assistant can look up an order by identifier and read its status, items, and dates.
2. Tool results are scoped to the requesting customer — a customer cannot read another
   customer's order through the assistant. (INV-D)
3. Tool calls and their results are attached to the turn as evidence.

*Accept when:* asking about an order the customer does not own yields "no such order", with no
leak of its existence.

### FR-4 — Action proposal

1. The AI service may emit a **fully-resolved** proposal: action type, concrete target
   identifiers, and the evidence that motivated it.
2. "Fully-resolved" means no placeholders, no free text to be interpreted later, and no
   ambiguity about which record is affected.
3. Every proposal is persisted before any policy evaluation. (INV-B)

*Accept when:* a proposal missing a concrete target is rejected as malformed **at the
boundary** and recorded as such — the boundary validates shape before policy evaluates
substance.

### FR-5 — Policy evaluation

1. The policy engine is **plain deterministic code** with no model in the path.
2. Rules are loaded from the database and are administrable (FR-12), not hard-coded.
3. A rule matches on action type plus conditions over the resolved target — for cancellation:
   order status, order age, order value.
4. Each rule yields an autonomy tier: `auto-execute`, `confirm-required`, or `agent-only`.
   **MVP wires `confirm-required` and `agent-only` only.** `auto-execute` is modelled and
   unit-tested but never selected, because shipping an auto-executing path in a portfolio
   project would undercut the very invariant the project exists to demonstrate.
5. Every evaluation produces a decision **plus the identity of the deciding rule**.

*Accept when:* every refusal can name the rule that refused it, in the agent console and in the
audit log.

### FR-6 — Confirmation

1. A `confirm-required` proposal is presented to the customer as the exact, resolved action in
   plain language — not a summary, and not the model's paraphrase.
2. Confirmation and rejection are both explicit user acts. **Timeout is not consent.**
3. Rejections are persisted. (INV-B)

*Accept when:* the confirmation text is generated from the resolved proposal record rather than
from model output, and a test asserts the two cannot diverge.

### FR-7 — Execution and audit

1. Execution occurs only after confirmation, and only via the single mutating route.
2. Policy is re-evaluated immediately before execution. (INV-E)
3. Execution carries an idempotency key; a duplicate confirmation returns the original result
   without re-executing.
4. An `ActionExecution` record captures the proposal ref, **both** policy decisions, the
   confirmation record, the idempotency key, the outcome, and timestamps.

*Accept when:* firing the same confirmation twice cancels the order once, and the second call
returns the first result.

### FR-8 — Escalation

1. The assistant hands off to a human with a stated reason.
2. Escalation is triggered by an `agent-only` policy decision, by low retrieval confidence, or
   by explicit customer request.
3. Escalation creates or updates a ticket in the agent queue.

*Accept when:* an `agent-only` decision always produces an escalation and never a dead end.

### FR-9 — Ticket lifecycle

1. Tickets move through an explicit state machine: `open → assigned → waiting → resolved →
   closed`.
2. Illegal transitions are rejected by the server, not merely hidden in the UI.
3. Every transition appends a `TicketEvent` recording who, when, and why. (INV-B)

*Accept when:* a direct API call attempting `open → closed` is rejected with a clear error.

### FR-10 — Agent console

1. Queue of tickets for the agent's tenant, filterable by state.
2. Full conversation history with evidence visible.
3. Blocked actions displayed **with the policy rule that blocked them**.
4. The agent may send, edit, or discard a proposed reply.

*Scope note:* if the project runs long, this is the first thing cut — down to a read-only
queue. The audit trail is not negotiable; the console's polish is.

### FR-11 — Audit query

1. Leads and admins can query the audit log by action type, decision, customer, and date.
2. Refused and rejected proposals are included by default, not filtered out.

*Accept when:* a lead can answer *"what did the assistant try to do this week that it was not
allowed to do"* in one query. This is the demo that sells the whole project.

### FR-12 — Policy administration

1. Admins can create, edit, and disable policy rules.
2. Rule changes are versioned and audited; a past decision remains explainable against the rule
   version that produced it.
3. Rule edits take effect without redeployment.

*Accept when:* editing a rule to forbid a previously-allowed cancellation changes the outcome
on the next proposal, while the historical record still names the old rule version.

### FR-13 — Auth, tenancy, privacy

1. Register, login, logout, session introspection. JWT in an httpOnly cookie with CSRF
   protection. (Ported, Project 2.)
2. Roles: `customer`, `agent`, `lead`, `admin`.
3. All business queries are tenant-scoped by query shape. (INV-D)
4. Account deletion cascades across conversations, messages, and tickets — but **audit records
   are retained in de-identified form**, because deleting the audit trail to satisfy a deletion
   request would destroy the evidence for INV-A. This tension is real, and the README will name
   it rather than pretend it does not exist.

### FR-14 — Health and observability

1. `/api/health` reports the API, the database, and AI-service reachability independently.
2. Structured logs carry a correlation id across Express → FastAPI → back.
3. Degradation is graceful: with the AI service down, the desk still serves tickets, history,
   and the agent console. Only new assistant turns are unavailable, and the UI says so plainly.

---

## 5. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| **NFR-1** | Time to first streamed token | p95 < 2.5 s on the dev machine, measured and reported honestly, not aspirationally |
| **NFR-2** | Policy evaluation latency | < 10 ms. It is in-process deterministic code and must never become a network call |
| **NFR-3** | Security | OWASP top-10 pass on the mutating route; rate limiting on auth and on the confirm endpoint; no secrets in the repo |
| **NFR-4** | Privacy | Customer PII never sent to the AI service beyond what the turn requires; audit retention rule documented (FR-13.4) |
| **NFR-5** | Availability | AI-service failure degrades to human-only support, never to a hung UI (FR-14.3) |
| **NFR-6** | Testability | The policy engine is pure and unit-testable with zero I/O. This is a **design constraint**, not a nice-to-have: if the policy engine needs a database call to decide, the design is wrong |
| **NFR-7** | Portability | Runs via Docker compose. On this machine images are authored and inputs verified but **not built**, because Docker is not installed. Stated plainly in the README |
| **NFR-8** | Accessibility | Keyboard-navigable console, labelled controls, visible focus. The confirmation dialog in particular must be fully operable without a mouse |
| **NFR-9** | Code quality | Conventional commits, one per meaningful step; CI green from the first phase that has code |

---

## 6. Measurable success criteria

The project succeeds if these numbers are true and reported. Two of the four measure
**restraint** rather than capability — which is the unusual thing about this project, and the
reason it is worth building.

| Metric | Target | How measured | Gates CI? |
|---|---|---|---|
| Unauthorised action rate | **exactly 0** | Deterministic policy eval over a golden set | **Yes** |
| Over-block rate (legitimate actions wrongly refused) | Reported, with a stated ceiling | Same eval, opposite direction | Yes |
| Wrongful deflection rate (conversations closed that a human should have handled) | Reported, no hard target | Escalation eval, labelled set | No — model-dependent |
| p95 time to first token | Reported | Instrumented in the streaming path | No |

The asymmetry is deliberate, and is Project 2's lesson applied: **only deterministic invariants
gate CI.** A model-dependent metric that gates a merge produces flaky builds and teaches the
team to ignore the gate.

---

## 7. Testing requirements

### 7.1 Suites

| Suite | Runner | Covers |
|---|---|---|
| Server | `node:test` | Policy engine (heaviest coverage), state machine, auth, tenancy, idempotency |
| Client | Vitest + Testing Library | Confirmation dialog, streaming states, console rendering |
| AI service | pytest | Retrieval, proposal shape validation, refusal behaviour |

### 7.2 Policy eval — deterministic, model-free

A golden set of `(proposed action, world state, expected decision)` triples run against the
real policy engine. Asserts an unauthorised-action rate of 0 and reports over-blocking. Runs in
milliseconds, so it gates every PR. Project 2's pattern.

### 7.3 Escalation eval — model-dependent

A labelled set of conversations that should or should not have escalated, measuring wrongful
deflection. Requires a live model, so it runs weekly and on demand. Project 1's pattern.

**Honest limitation, stated up front:** live model calls are currently blocked on this machine
by a GPU CUDA fault (§8). The escalation eval will be **authored and unit-tested against
recorded fixtures**, not run against a live model, unless that changes. The policy eval is
unaffected — it is model-free by design, which is precisely why the important invariant was
made model-free.

### 7.4 What the evals do not cover

Stated in each eval's own README section: no adversarial prompt-injection suite, no multi-turn
manipulation testing, and no load testing of the mutating route beyond idempotency. These are
named as future work rather than quietly omitted.

---

## 8. Environment constraints and assumptions

| Constraint | Consequence |
|---|---|
| Node v24.19.0 at `F:\node.exe`, not on the default PATH | PATH refresh needed before `node`/`npm` in a fresh shell |
| The user's shell is Windows PowerShell 5.1 — **no `&&`** | All user-facing commands use `git -C "<path>"` / `npm --prefix "<path>"` form, or `;` chaining |
| `gh` CLI not installed | The repo is created manually at github.com/new; pushes are run by the user (no tty here for credential auth) |
| Docker not installed | Compose files authored and validated, images not built (NFR-7) |
| GPU CUDA fault blocks local model inference | Escalation eval runs against fixtures (§7.3) |
| MongoDB required | Local instance or Atlas free tier; connection string via env, never committed |

**Assumption:** demo order data is seeded by a script committed to the repo, so any reviewer can
reproduce the demo. If they cannot reproduce it, the demo is a claim rather than evidence.

---

## 9. Requirement → phase traceability

So that no requirement is orphaned and no phase is aimless.

| Phase | Delivers |
|---|---|
| 1 requirements | *this document* |
| 2 architecture + ADRs | INV-A, INV-D, INV-E as ADRs |
| 3 DB design | Entities behind FR-4…FR-9, INV-B |
| 4 UI/UX | FR-6, FR-10, NFR-8 |
| 5 frontend foundation | FR-1, FR-13 |
| 6 backend API contract | FR-1…FR-14 as a contract |
| 7 DB integration | INV-B, INV-D |
| 8 auth | FR-13, INV-D |
| 9 KB ingest *(ported)* | FR-2, INV-C |
| **10 core: tools, policy, propose/confirm/execute, audit** | **FR-3…FR-7, FR-11, INV-A, INV-E** |
| 11 escalation + lifecycle | FR-8, FR-9 |
| 12 security | NFR-3, NFR-4 |
| 13 evals | §6, §7.2, §7.3 |
| 14 performance | NFR-1, NFR-2 |
| 15 deployment + CI | NFR-7, NFR-9 |
| 16 README + case study | §1.2, §1.3 honesty statements |
| 17 interview prep | §3 invariants, §6 metrics |

Phase 10 carries the largest share of requirements. That is intentional — it is the project.

---

## 10. Open questions carried into Phase 2

1. **Where does the confirmation live** — inline in the conversation stream, or a modal? The
   modal is more explicit and harder to click through by accident; inline keeps conversational
   flow. Leaning modal, because "harder to click through by accident" *is* the feature.
   Decided in Phase 4.
2. **Are policy rules per-tenant or global?** Per-tenant is more realistic and costs one field;
   global is simpler to seed. Leaning per-tenant. Decided in Phase 3.
3. **Does the customer see the refusal reason** when policy blocks an action? Telling them
   "cancellation is not permitted after dispatch" is good service; telling them the rule id is
   an information leak. Needs a deliberate split between customer-facing and internal reason
   text. Decided in Phase 2.

---

*Phase 1 complete. Phase 2 turns INV-A, INV-D and INV-E into ADRs, and answers question 3
above.*
