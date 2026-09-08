# ADR 0001 — Three-tier architecture: React, Express, FastAPI

- **Status:** Accepted
- **Date:** 2026-09-08 (Phase 2)
- **Ported from:** Projects 1 and 2, ADR 001 in both. Re-affirmed, not re-litigated.
- **Relates to:** [ADR 0002](0002-llm-proposes-never-authorises.md)

## Context

The system needs a browser UI, a business/data layer, and a machine-learning layer
(sentence-transformers embeddings, retrieval, LLM orchestration). Projects 1 and 2 both settled
on a three-tier split, and this project inherits the same forces:

- The ML ecosystem this project depends on — `sentence-transformers`, the FAISS-style index,
  the tokenizer stack — is Python-first. Reimplementing retrieval in Node would be re-deriving
  work that Project 1 already shipped.
- The auth, tenancy, CSRF and immutability code being ported from Project 2 is Express +
  Mongoose. Porting *that* into Python would be the mirror-image waste.

What is *new* in this project is that the tier boundary is asked to carry a second job: it is
also the trust boundary (ADR 0002). That raises the stakes of getting the split right, but does
not change the split itself.

## Decision

Three tiers, one of which is not publicly routable:

| Tier | Runtime | Port | Publicly routable | Owns |
|---|---|---|---|---|
| Client | React 18 + Vite | 5179 | yes | UI, streaming render, confirmation dialog |
| API | Node 22 + Express 5 | 4400 | yes | auth, tenancy, tickets, **policy engine, action execution, audit** |
| AI service | Python 3.12 + FastAPI | 8200 | **no** | retrieval, intent, drafting, escalation signal, action *proposal* |

The client never talks to the AI service. Every request reaches Express first. The AI service
is reachable only from the API tier, on the internal network in deployment and on localhost in
development.

**Express owns everything with consequences. Python owns everything advisory.**

## Consequences

**Positive**

- The proposal path crosses a process boundary, which makes "the model cannot execute" a
  deployment fact rather than a code-review convention.
- Retrieval ports from Project 1 unchanged; auth and tenancy port from Project 2 unchanged.
- The AI service can be restarted, scaled, or taken down without touching business data. This
  is what makes graceful degradation (FR-14.3) cheap.

**Negative**

- An extra network hop on every assistant turn, and a second runtime to install, configure and
  deploy. Accepted: the hop is on the streaming path where the LLM dominates latency anyway.
- Two dependency ecosystems, two test runners, two lint configs.
- Correlation ids must be threaded manually across the hop to keep logs readable (NFR-8,
  addressed in the architecture doc).

**Neutral**

- The third repo in the series is navigable by anyone who read the second, because the shape is
  identical.

## Alternatives considered

**Single Node service calling a hosted LLM API directly.** Fewer moving parts, no Python. 
Rejected on two counts: it discards Project 1's retrieval stack, and — more importantly — it
removes the natural place to put the trust boundary. The model's proposal and the code that
executes it would live in the same process, sharing the same database handle. INV-A would
degrade from an architectural property to a coding convention.

**FastAPI serving everything, no Node tier.** Python can serve a web API perfectly well. 
Rejected because it throws away the ported Express auth, tenancy, CSRF and immutability work
from Project 2, and would put the model orchestration and the mutation code back in one
process — the same objection as above.

**Two tiers with the AI service publicly routable.** Rejected outright. A publicly reachable
advisory service is an unauthenticated path to the model, and it invites a future contributor
to "just add a small write endpoint here".

## Verified by

- Deployment config exposes 5179 and 4400 only; 8200 is internal (Phase 15).
- An integration test asserts the AI service has no credential that permits a write to business
  collections (Phase 10).
