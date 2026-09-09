# AI Support Desk

An AI support assistant that **takes actions with consequences** — and structurally cannot take
one nobody authorised.

The assistant answers customer questions from a help-center knowledge base, looks up real order
data, and can **cancel an order**. That last capability is the point of the project. The
retrieval half is deliberately reused: it is ported from
[Project 1, the AI Knowledge Assistant](https://github.com/Manoj132508/ai-), not rewritten, and
this README will keep saying so. The new engineering is everything between the model deciding
it wants to cancel an order and that cancellation actually happening.

> **INV-A — the invariant this project exists to demonstrate**
>
> The language model may **propose** an action. It may never **authorise** one. Every
> side-effecting action passes a deterministic policy evaluation *and* an explicit confirmation
> of the exact, fully-resolved action before it executes.

INV-A is not a prompt instruction. If the system prompt were deleted tomorrow, it would still
hold — the AI service simply has no write path to business data. That is what makes it an
architectural property rather than a hope.

---

## Status

**Phase 6 of 17 — client and API contract both running.** 57 tests pass across two suites, and
CI runs both on every push. This repository is public from Phase 1 on purpose, so CI runs
during the build rather than after it.

### Running it

Requires Node 22+. Auth arrives in Phase 8, so the sign-in screen renders but cannot yet
authenticate; every API route is mounted and correctly shaped, returning `501` with the phase
that builds it.

```bash
npm --prefix client install
npm --prefix server install
```

```bash
npm --prefix client run dev     # http://localhost:5179
npm --prefix server run dev     # http://localhost:4400
```

```bash
npm --prefix client test        # 39 tests
npm --prefix server test        # 18 tests
```

Copy `.env.example` to `.env` before Phase 6. The database is **MongoDB Atlas free tier** —
Atlas clusters are replica sets by default, which this project requires: execution commits the
order update, the audit record and the ticket event in one multi-document transaction, and a
standalone `mongod` cannot do that. A local replica-set fallback is documented in
`.env.example`.

| Document | |
|---|---|
| [Project brief](docs/project-brief.md) | Why this project, and what it deliberately is not |
| [Phase 1 — Requirements](docs/phases/phase-01-requirements.md) | Invariants, FRs, NFRs, success metrics, traceability |
| [Phase 2 — Architecture](docs/phases/phase-02-architecture.md) | Component and trust view, request flows, failure modes |
| [Phase 3 — Database design](docs/phases/phase-03-database-design.md) | Eleven collections, the policy rule model, indexes, privacy |
| [Phase 4 — UI/UX](docs/phases/phase-04-ui-ux.md) | Screens, the confirmation surface, error affordances, accessibility |
| [Phase 5 — Frontend foundation](docs/phases/phase-05-frontend-foundation.md) | What was ported, what is new, the 39 tests, CI |
| [Phase 6 — API contract](docs/phases/phase-06-api-contract.md) | Endpoints, the error envelope, status mapping, SSE frames |
| [Decision records](docs/adr/README.md) | Nine ADRs — start with [0002](docs/adr/0002-llm-proposes-never-authorises.md) |

---

## The path an action takes

```
customer message
      │
      ▼
 FastAPI (advisory)      retrieval · intent · drafting · action PROPOSAL
      │                  executes nothing, holds no write credentials
      │  proposal crosses the trust boundary as a REQUEST
      ▼
 Express (consequential) ── policy engine ──▶ refuse ──▶ audit ──▶ escalate
      │                     deterministic,
      │                     no model in path
      ▼
 explicit user confirmation of the resolved action
      │
      ▼
 re-evaluate policy  ──▶ execute (idempotent) ──▶ immutable audit record
```

Two details in that diagram do most of the work:

- **Policy is re-evaluated at execution time**, not just at proposal time. Time passes between
  proposing and confirming; the order may have shipped, or the rule may have changed. Treating
  an authorisation as permanent is the classic time-of-check/time-of-use bug.
- **Refused proposals are kept.** What the model tried to do and was stopped from doing is the
  evidence that the invariant works. Deleting refusals would delete the proof.

---

## Honest scoping

Stated here rather than discovered later:

- **Orders are seeded demo records.** There is no e-commerce integration. The impressive part —
  cancelling an order — is cancelling a fake order through a real authorisation path.
- **Retrieval is ported from Project 1.** It is not new work and is not presented as new work.
- **One side-effecting action** (cancel an order) done completely, rather than several done
  shallowly. The policy engine generalises; the MVP does not exercise that generality.
- **`auto-execute` autonomy tier is modelled but never wired.** Shipping an auto-executing path
  would undercut the invariant this project exists to demonstrate.

---

## Tech stack

Everything here already appears in Projects 1 and 2. No technology was added to look
sophisticated.

React 18 + Vite · Node 22 + Express 5 + Mongoose · MongoDB · Python 3.12 + FastAPI ·
sentence-transformers · provider-neutral LLM (Ollama by default) · Docker Compose ·
GitHub Actions

Ports **5179** client / **4400** API / **8200** AI — chosen so this and both prior projects can
run side by side.

---

## Project series

| | Project | The honesty constraint | What the LLM may not do |
|---|---|---|---|
| 1 | [AI Knowledge Assistant](https://github.com/Manoj132508/ai-) | Grounded answers, honest refusal | Answer beyond the retrieved evidence |
| 2 | [AI Career & ATS Platform](https://github.com/Manoj132508/ai-career-platform) | No fabricated credentials | Score, judge, or invent a claim |
| 3 | **AI Support Desk** *(this repo)* | No unauthorised action | Authorise anything with a consequence |

*Saying → phrasing → doing.* Each project takes the same discipline one step further in
consequence.

---

## Licence

MIT
