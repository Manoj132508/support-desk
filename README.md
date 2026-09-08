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

**Phase 1 of 17 — requirements complete.** No application code yet. This repository is public
from Phase 1 on purpose, so CI runs during the build rather than after it.

| Document | |
|---|---|
| [Project brief](docs/project-brief.md) | Why this project, and what it deliberately is not |
| [Phase 1 — Requirements](docs/phases/phase-01-requirements.md) | Invariants, FRs, NFRs, success metrics, traceability |

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
