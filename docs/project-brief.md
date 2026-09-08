# Project 3 — AI Support Desk · Pre-Phase-1 Brief

**Status: DRAFT FOR YOUR REVIEW. No code written, no repo initialised.**
Phase 1 does not begin until you have read this and pushed back on it.

Working directory: `C:\Users\manoj\Desktop\ai-support-desk` (rename freely — nothing is
committed yet). Ports **5179 client / 4400 API / 8200 AI**, chosen to avoid collision with
Project 1 (5177/4200/8000) and Project 2 (5178/4300/8100), so all three can run side by side
in an interview.

---

## The steering decision that shapes everything below

An "AI customer support system" built the obvious way is **Project 1 wearing a different
hat**: retrieve from help-center documents, generate a grounded answer, refuse when the
documents do not cover it. You have already built that, shipped it, and written an
interview-prep document about it. Building it again adds a repo to your portfolio and
nothing to your case.

So the retrieval half of this project is deliberately **the boring, reused half** — ported
from Project 1, not rewritten, and described honestly as such in the README.

The new engineering, and the reason this project earns its place, is that **this assistant
takes actions with consequences**. It does not only answer "what is your refund policy"; it
can cancel an order or change a delivery address. Projects 1 and 2 never mutate anything on
a user's behalf. This one does, and that changes the entire risk profile.

**The signature invariant — INV-A (no unauthorised action):**

> The language model may *propose* an action. It may never *authorise* one. Every
> side-effecting action passes a deterministic policy check and an explicit user
> confirmation of the exact, fully-resolved action before it executes.

This is the structural parallel to Project 2's ADR 002 (*the LLM never scores; it only
rephrases grounded text*) — and it is a genuinely different claim, which is the point. Read
across the three projects it makes a clean arc:

| Project | The honesty constraint | What the LLM may not do |
|---|---|---|
| 1 · Knowledge Assistant | Grounded answers, honest refusal | Answer beyond the retrieved evidence |
| 2 · Career Platform | No fabricated credentials | Score, judge, or invent a claim |
| 3 · Support Desk | No unauthorised action | Authorise anything with a consequence |

*Saying → phrasing → doing.* Each project takes the same discipline one step further in
consequence. That sentence is the portfolio's thesis, and this project is what makes it a
trilogy instead of two projects and a spare.

---

## 1. Objective

Build a customer support desk where an AI assistant resolves routine requests end to end —
including requests that change real records — while making it structurally impossible for
the model to take an action no human policy authorised, and honest about when it should
hand off to a person instead.

## 2. Business problem

Support teams face two failure modes, and most "AI support" products trade one for the other.

**Under-automation** is the status quo: a human reads "where is my order", opens the order
system, copies a tracking number, pastes it back. High cost, slow response, and the agent's
skill is wasted on lookups.

**Over-automation** is the newer and more expensive failure. A confident bot tells a customer
their refund is processed when it is not, cancels the wrong order, or loops a frustrated
customer through deflection while an SLA burns. The damage is not a bad answer — it is a
wrong *action*, or a wrongly *withheld* escalation. Both are hard to detect after the fact
without an audit trail.

This project treats the second failure as the engineering problem. The measurable claims:
**zero unauthorised actions** (enforced deterministically, not prompted), and a **known,
reported wrongful-deflection rate** — conversations the assistant closed that a human should
have handled.

## 3. Users

**Customer** — arrives with a problem, wants it resolved in one conversation. Never sees the
internals; does see a confirmation prompt before anything changes.

**Support agent** — works a queue of conversations the assistant escalated or was never
allowed to handle. Sees the proposed reply, the evidence behind it, and any blocked action
with the policy rule that blocked it. Can send, edit, or discard.

**Support lead / admin** — owns the policy rules deciding what the assistant may do
autonomously, and reads the audit log. This is the user that makes INV-A meaningful: policy
is *data they edit*, not a prompt a developer wrote.

## 4. Core features (MVP)

Scope discipline: **one side-effecting action done completely** beats five done shallowly.
The full propose → policy → confirm → execute → audit path is the product; breadth of actions
is a post-MVP loop.

1. **Customer conversation** — multi-turn, streamed token by token (SSE, ported from
   Projects 1 and 2 including cancellation).
2. **Grounded answers** from a help-center knowledge base, with citations and an honest
   "I don't have that" refusal. *Ported from Project 1; explicitly not new work.*
3. **Read-only tools** — order lookup and status. The assistant retrieves real structured
   data, not just documents. This is where it stops resembling Project 1.
4. **One side-effecting action: cancel an order.** Full path — the model proposes a
   fully-resolved action, the deterministic policy engine authorises or refuses it, the
   customer confirms the exact action in the UI, execution is idempotent, and an immutable
   audit record is written.
5. **Escalation to a human** — the assistant hands off with a reason; the conversation
   becomes a ticket in the agent queue.
6. **Ticket lifecycle** — an explicit state machine (`open → assigned → waiting → resolved →
   closed`) over an append-only event log.
7. **Agent console** — queue, conversation history, proposed reply with evidence, and any
   policy-blocked action shown with the rule that blocked it.
8. **Audit log** — every proposed, refused, confirmed and executed action, queryable.
9. **Auth, tenancy, privacy** — ported from Project 2 (JWT httpOnly cookie + CSRF, tenancy by
   query shape returning 404 not 403, deletion cascade).

## 5. Advanced features (post-MVP, if time)

- A second and third action (address change, refund) to prove the policy engine generalises
  rather than being hard-coded to one case.
- Autonomy tiers per action type: auto-execute / confirm-required / agent-only.
- Suggested-reply mode for agents on tickets the assistant may not close itself.
- SLA timers and queue routing.
- Sentiment-triggered escalation.

## 6. Architecture

The three-tier spine is **ported, not redesigned** — ADR 001 in both prior projects.

```
React (5179) ─── Express API (4400) ─── FastAPI AI service (8200)
                        │                         │
                     MongoDB               KB index + LLM (Ollama)
```

**Express owns everything with consequences.** Auth, tenancy, the ticket state machine, the
append-only event and audit logs, the **policy engine**, and action execution. The policy
engine is ordinary deterministic code — rules loaded from the database, evaluated in process,
fully unit-testable, no model in the path.

**Python owns everything advisory.** KB retrieval (ported), intent classification, reply
drafting, the escalation signal, and action *proposal*. It returns structured proposals; it
executes nothing and is never publicly reachable.

The boundary is the invariant. A proposal crossing from Python to Node is a *request*, and
Node is free to refuse it. This is why INV-A is an architectural property rather than a
prompt instruction — the same reasoning as Project 2's "the LLM never scores".

## 7. Tech stack

Everything here is already on your CV or already in Projects 1 and 2. No new technology is
added to look sophisticated.

- **Frontend:** React 18 + Vite (plain JS), the token/primitive system from Project 2
- **API:** Node 22 + Express 5, Mongoose
- **Database:** MongoDB
- **AI service:** Python 3.12 + FastAPI, sentence-transformers (ported)
- **LLM:** provider-neutral, Ollama by default (free, local, no API key)
- **Infra:** Docker + compose, GitHub Actions

## 8. Database entities (MongoDB)

| Entity | Notes |
|---|---|
| `User` | agent / lead / admin. Ported from Project 2. |
| `Customer` | the end user in a conversation |
| `Order` | the structured business record actions operate on (seeded demo data) |
| `Conversation` | multi-turn thread, belongs to a customer |
| `Message` | one turn; assistant messages carry evidence refs |
| `Ticket` | lifecycle state + denormalised `currentStatus` |
| `TicketEvent` | **append-only** — every state transition, who and why |
| `PolicyRule` | admin-editable: action type, conditions, autonomy tier |
| `ActionProposal` | what the model asked for, fully resolved, with its evidence |
| `ActionExecution` | **immutable audit** — proposal ref, policy decision, confirmation, idempotency key, result |

Immutability is enforced by the `immutablePlugin` pattern already written for Project 2 —
ported, not rewritten. `ActionProposal` and `ActionExecution` are the audit spine: a
proposal that was refused is kept, because *what the model tried to do and was stopped from
doing* is the evidence that INV-A works.

## 9. API endpoints (sketch)

```
POST   /api/auth/register | login | logout        GET /api/auth/me
POST   /api/conversations                          GET /api/conversations/:id
POST   /api/conversations/:id/messages   (SSE stream: token* → proposal? → done)
POST   /api/proposals/:id/confirm                  POST /api/proposals/:id/reject
GET    /api/tickets            GET /api/tickets/:id        POST /api/tickets/:id/status
POST   /api/tickets/:id/escalate
GET    /api/policies           PUT /api/policies/:id       (admin)
GET    /api/audit                                          (lead/admin)
GET    /api/health
```

The confirm endpoint is the one worth studying: it takes an idempotency key, re-evaluates
the policy at execution time (not just proposal time), and is the only route in the system
that mutates business data.

## 10. Folder structure

Mirrors Projects 1 and 2 exactly, so the third repo is navigable by anyone who read the
second — `client/`, `server/` (models, controllers, routes, middleware, services, utils),
`ai-service/` (app, evaluation), `docs/` (brief, phases, adr, case-study, interview-prep),
`.github/workflows/`.

## 11. Phases (17, with the Projects 1–2 lessons baked in)

1 requirements · 2 architecture + ADRs · 3 DB design · 4 UI/UX · 5 frontend foundation ·
6 backend API contract · 7 DB integration · 8 auth · 9 KB ingest (**ported**) ·
10 **the core: tools, policy engine, proposal/confirm/execute, audit** · 11 escalation +
ticket lifecycle · 12 security · 13 **evals** · 14 performance · 15 deployment + CI ·
16 README + case study · 17 interview prep.

Two deliberate changes from Project 2's ordering. The core moves earlier and gets two
phases, because it is the whole project. And **the repo goes to GitHub at Phase 1, not
Phase 17** — both prior projects were pushed only at the very end, which meant CI never
ran during the build and the first push was a 21-commit leap of faith.

## 12. Testing plan

Three suites as before (server `node:test`, client Vitest, Python pytest), plus **two eval
harnesses** — this project inherits both patterns you have already built:

- **Policy eval (deterministic, model-free).** A golden set of proposed actions against
  policy rules. Asserts the unauthorised-action rate is **0** and that no legitimate action
  is over-blocked. Costs milliseconds, so it **gates every PR** — Project 2's pattern.
- **Escalation eval (model-dependent).** A labelled set of conversations that should or
  should not have been escalated, measuring wrongful-deflection rate. Needs a model, so it
  runs **weekly and on demand** — Project 1's pattern.

The honest-scoping lesson from Project 2 applies: each eval states plainly what it does *not*
cover, and only the deterministic invariants gate CI.

## 13. Deployment plan

Docker + compose for all four services, ported from Project 2 with ports adjusted. Same
honest caveat expected: images authored and inputs verified, but Docker is not installed on
this machine, so they will not be built here unless that changes.

## 14. GitHub strategy

Public repo **from Phase 1** at `Manoj132508/ai-support-desk`. Conventional commits, one per
meaningful step, never a bulk dump. CI green from the first phase that has code. ADRs
committed as decisions are made, not reconstructed afterwards.

Note the standing constraints: no `gh` CLI here, so you create the empty repo at
github.com/new; and your PowerShell 5.1 rejects `&&`, so I will hand you `git -C "<path>"`
commands.

## 15. Interview topics this project earns

- Designing a trust boundary so an invariant is architectural, not prompted
- Idempotency and re-checking authorisation at execution time, not just proposal time
- Append-only audit logs, and why refused proposals are kept
- State machines over ad-hoc status fields
- Tool use / function calling, and why the tool layer is not the security layer
- Measuring an AI system's *restraint* rather than its capability
- Deliberate reuse: what was ported, what was new, and how you decided

---

## My honest concerns before you approve

**1. Overlap with Project 1 is the real risk.** Everything above is designed to manage it,
but an interviewer skimming two READMEs may still see "two RAG chatbots". Mitigation: the
README leads with the action/policy layer and states in its first paragraph that retrieval is
reused from Project 1. If that framing does not convince you, say so now — it is cheaper to
change the concept than the code.

**2. This is the biggest of the three.** A policy engine, a ticket state machine, an agent
console, and two eval harnesses is more surface than Project 2. The MVP scoping above (one
action, done fully) is my main defence, and I would rather cut the agent console than the
audit trail if we run long.

**3. The demo data problem.** Actions need orders to act on, so the project ships seeded
demo orders. That is honest and normal, but it means the impressive part (cancelling a real
order) is cancelling a fake order. The README should say so plainly rather than implying an
e-commerce integration exists.

**4. Live model calls still will not run here.** The GPU CUDA fault blocked them in both
prior projects. The deterministic policy eval is unaffected — it is model-free by design —
but the escalation eval will be authored and unit-tested rather than run against a live
model, unless the machine situation changes.
