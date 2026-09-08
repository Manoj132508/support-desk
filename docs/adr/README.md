# Architecture Decision Records

Decisions are recorded as they are made, not reconstructed afterwards. Each ADR states the
forces in play, the decision, its consequences (including the bad ones), and the alternatives
that were rejected and why.

| # | Decision | Status | Enforces |
|---|---|---|---|
| [0001](0001-three-tier-architecture.md) | Three-tier architecture: React, Express, FastAPI | Accepted | — *(ported)* |
| [0002](0002-llm-proposes-never-authorises.md) | **The LLM proposes; it never authorises** | Accepted | **INV-A** |
| [0003](0003-recheck-at-execution-and-idempotency.md) | Authorisation is re-checked at execution; execution is idempotent | Accepted | **INV-E** |
| [0004](0004-policy-as-data.md) | Policy is data, evaluated by a pure function, deny by default | Accepted | INV-A |
| [0005](0005-tenancy-by-query-shape.md) | Tenancy by query shape; 404 never 403 | Accepted | **INV-D** *(ported)* |
| [0006](0006-append-only-audit-retains-refusals.md) | Append-only audit that retains refusals | Accepted | **INV-B** |
| [0007](0007-two-channel-refusal-reasons.md) | Two-channel refusal reasons | Accepted | — |

**Start with [0002](0002-llm-proposes-never-authorises.md).** It is the central decision of the
project; every other ADR either supports it or is inherited from an earlier project.

INV-C (grounded or silent) has no ADR here — it is inherited wholesale from Project 1 along
with the retrieval stack, and re-deriving it would be pretending to a decision this project did
not make.
