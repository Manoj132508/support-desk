# ADR 0002 — The LLM proposes; it never authorises

- **Status:** Accepted
- **Date:** 2026-09-08 (Phase 2)
- **Enforces:** INV-A
- **Relates to:** [ADR 0001](0001-three-tier-architecture.md),
  [ADR 0003](0003-recheck-at-execution-and-idempotency.md),
  [ADR 0004](0004-policy-as-data.md)

This is the central decision of the project. Every other ADR exists to support it.

## Context

The assistant can cancel an order. The moment a language model's output can cause a database
mutation, the question stops being "is the answer good?" and becomes "what stops a wrong answer
from becoming a wrong action?"

The default way to build this in 2026 is **tool calling**: describe `cancel_order(order_id)` to
the model, let the framework parse the model's tool call, and execute it. The model decides
*whether* to call, *what* to call it with, and the framework executes. That design makes the
model the authoriser.

Three things then go wrong, and none are hypothetical:

1. **Prompt injection.** A customer pastes text that reads as an instruction. The order data
   itself, or a KB document, can carry one.
2. **Ordinary model error.** The model resolves "cancel my order" against the wrong order id
   from a multi-order conversation.
3. **Silent scope creep.** A tool is added later with a slightly wider blast radius, and nobody
   re-reasons about who is allowed to invoke it.

The tempting fixes — a firmer system prompt, an allowlist of tools, a second model to check the
first — all share a flaw: they ask the probabilistic component to be the safety component.

**The key realisation: the tool layer is not the security layer.** An allowlist says
`cancel_order` is a permitted *kind* of action. It does not say that cancelling *this* order,
*now*, for *this* customer, under *today's* rules, is permitted. That second question is the
only one that matters, and it is not a question about the model at all.

## Decision

The AI service returns a **structured `ActionProposal`**. It executes nothing.

```
FastAPI                          Express
────────                         ───────
build proposal   ──request──▶    1. validate SHAPE at the boundary
  · action type                  2. persist the proposal (before any decision)
  · resolved target ids          3. evaluate POLICY — deterministic, no model
  · evidence refs                4. require explicit user CONFIRMATION
  · no credentials               5. re-evaluate policy, then EXECUTE (ADR 0003)
                                 6. write immutable audit record
```

Four properties make this an invariant rather than a convention:

1. **No write path.** The AI service's database credential is read-only on the KB and has no
   access to business collections. There is no code in the Python tier that can mutate an
   order, and no credential that would let one work if someone wrote it.
2. **A proposal is a request, not a command.** Express is free to refuse it, and refusal is a
   normal outcome, not an error path.
3. **Shape is validated before substance is evaluated.** A malformed proposal — a placeholder
   target, a missing id, an unknown action type — is rejected at the boundary and recorded as
   malformed. Policy never sees it. This keeps the policy engine's input space small and
   totally specified.
4. **The proposal must be fully resolved.** No free text for Express to interpret later, no
   "the customer's most recent order". Concrete identifiers only. If the model cannot resolve
   the target, it must ask the customer, not guess — an ambiguous proposal is a malformed one.

**The test of this decision:** delete the system prompt, and INV-A still holds. The model could
propose anything it likes, in any tone, and the worst outcome is a refused proposal and an audit
row. That is what "architectural, not prompted" means.

## Consequences

**Positive**

- INV-A survives prompt injection, model swap, model error, and a compromised AI service. The
  blast radius of the AI tier is "bad advice", never "bad action".
- The audit trail becomes meaningful. Because refusals are recorded (ADR 0006), the system can
  answer *what did the model try to do that it was not allowed to do* — evidence the invariant
  is live, not just claimed.
- Policy reasoning is testable without a model (ADR 0004), which is why the important eval can
  gate CI.

**Negative**

- Off-the-shelf agent frameworks that execute tools inline cannot be used for the action path.
  The proposal/confirm/execute chain is written by hand. Accepted — that hand-written chain
  *is* the project.
- Every new action type needs work in two tiers plus a policy rule. Deliberate friction: an
  action that is cheap to add is an action nobody re-reasons about.
- Latency: the customer sees a confirmation step rather than an instant result. This is a
  product cost, and it is the correct one to pay.

**Neutral**

- Read-only tools (order lookup, FR-3) do **not** go through this chain. They are scoped by
  tenancy (ADR 0005) and are not side-effecting, so subjecting them to policy would add
  ceremony without adding safety. The boundary is drawn at *mutation*, not at *tool use*.

## Alternatives considered

**Prompt-based guardrails.** "Never cancel an order without asking." Rejected: unenforceable,
untestable, and silently degrades when the model or the prompt changes. It also cannot be
proven — there is no test that shows it holds for inputs nobody thought of.

**LLM-as-judge validating the first model's action.** A second model checks the first. 
Rejected: this is a probabilistic check on a probabilistic component. It reduces error rate but
cannot make it zero, and INV-A's whole value is that it is exactly zero. It also costs a second
inference on the critical path.

**Tool allowlist with inline execution.** Constrain which tools exist, then let the framework
execute them. Rejected for the reason in Context: an allowlist constrains *which* action, never
*whether this instance* of it is permitted. It has no view of the order's status, the rule set,
or the customer's identity at the moment of execution.

**Human review of every action, no policy engine.** Safe, and useless — it is the
under-automation failure the project exists to avoid, and it makes the assistant a
form-filling UI for an agent.

## Verified by

- **Policy eval, deterministic and model-free** (Phase 13): asserts unauthorised-action rate is
  exactly 0 over a golden set. Gates every PR.
- Unit tests asserting a malformed or unresolved proposal is rejected at the boundary and never
  reaches the policy engine.
- An integration test asserting the AI service credential cannot write to business collections.
