# Phase 10 — The core

**Project 3 · AI Support Desk**
Status: **in progress.** The engine, the proposal boundary, the propose → confirm → execute
service and its MongoDB repository are built, tested and committed. The customer confirm and reject
routes are built and verified; the `proposal` stream frame, the policy and audit endpoints and the seed script are
still to build (§9). This document records findings as they are made rather than reconstructing
them at the end.

This is the phase the project exists for. ADR 0002 (the model proposes, never authorises) and
ADR 0003 (re-check at execution, execute at most once) stop being documents here.

---

## 1. What exists

```
server/src/policy/
  vocabulary.js       the ladder, condition registry, problem codes, decision reasons — NO imports
  engine.js           evaluate({ rules, proposal, world, now }) — a pure function
  baselineRules.js    the platform baseline, version-controlled
  proposal.js         the boundary: shape, resolution, confirmation text
  actionService.js    propose → confirm → execute, over an injected repo
  mongoActionRepo.js  tenancy, once-only outcomes, atomic conditional execution
server/src/db/models/audit.js   + PolicyDecision, + ActionProposal.validity/problemCodes/confirmText
server/src/routes/proposals.js  customer-only confirm and reject
```

Server suite: **239 tests**, including the confirm and reject routes.

---

## 2. Before building: the suite that was green by luck

The phase began with an integrity check, because this machine has recorded NTFS corruption and
every commit in this repository exists on that one disk. Git was intact — `fsck` clean, working
tree clean. But the Python suite, **23/23 two days earlier, now failed 4/23 with no file
changed.**

It was tempting to blame the disk. The evidence pointed elsewhere: a clean tree rules out a
corrupted tracked file, and the fake embedder bucketed tokens with Python's built-in `hash()`,
which is salted per process. A sweep across fixed `PYTHONHASHSEED` values confirmed it. The fix
and the regression test are recorded in the
[Phase 9 amendment](phase-09-kb-ingest-and-ai-service.md). The lesson worth keeping here is the
order of reasoning: **check the evidence before blaming the hardware — and before ruling it
out.**

---

## 3. The policy engine

`evaluate()` reads no database, no clock, no environment and no network. Rules, facts and the
current time are all passed in. Three things follow: it can be tested exhaustively in
milliseconds; the execution-time re-check costs nothing; and the policy eval can gate every pull
request, because nothing in its path can flake. Static tests assert the engine imports only its
vocabulary and never reads `Date.now`, `new Date()` or `process.env`.

### 3.1 ADR 0004 contradicted itself

ADR 0004 says both *"the first match wins"* and *"the more restrictive tier wins"*. Implemented
literally, those contradict each other, and the first is dangerous: a tenant rule with a lower
priority number would match first and shadow a baseline `refuse` rule that was never examined —
exactly the relaxation ADR 0008 promises cannot happen.

**The engine evaluates every rule and takes the most restrictive match.** Priority only decides
which of several equally restrictive rules is *reported* as the decider. Recorded as an
[ADR 0004 amendment](../adr/0004-policy-as-data.md#amendments).

The ordering is total — priority, then rule key, then newest version, then id — so a decision
never depends on the order the database returned rules in. The final tie-break matters for one
case: a baseline and a tenant rule can share a key and version, and without it *which one is
recorded as deciding* would depend on return order. The outcome would agree; the audit would not.
A test checks all 24 orderings of a four-rule set.

### 3.2 Two kinds of bad input, treated differently

| Input | Example | Behaviour |
|---|---|---|
| Programming error | no proposal, no `now` | **Throws** — a broken caller should fail loudly in a test |
| Data condition | a fact is missing, a rule is invalid | **Fails closed** to `agent-only`, and says why |

Two consequences are worth stating on their own:

- **A missing fact overrides a permissive match.** If a catch-all would allow confirmation but a
  refusal rule cannot be checked because a fact is missing, the answer is `agent-only`. Treating
  "could not check" as "did not apply" would turn missing data into authorisation.
- **An invalid rule fails closed rather than being skipped.** Skipping a broken refusal is a
  relaxation.

The engine is also precise rather than merely strict: a missing fact is not consulted when an
earlier condition in the same rule has already ruled that rule out, because it could not have
changed the answer.

### 3.3 One vocabulary, no imports

The ladder and the condition registry were first declared beside the schema — which meant the
engine imported Mongoose to read them. They now live in `vocabulary.js`, which imports nothing;
the schema re-exports the same objects, and a test asserts identity rather than equality.

---

## 4. The proposal boundary, and recording malformed attempts

ADR 0002's first step is **shape before substance**. `validateProposalShape` holds a proposal from
the untrusted AI service to exactly one shape before the engine may reason about what it means.

- **Unknown fields are rejected, not stripped.** A proposal carrying `authorised: true` is an
  untrusted caller asserting a decision only the API may make. Stripping the field would make that
  attempt invisible; rejecting it makes it a record. It gets its own code,
  `asserted_authorisation`, so the audit can count authorisation claims separately from typos.
- **Placeholders are not targets.** `"latest"`, `"<orderNumber>"`, `"the customer's most recent
  order"` are malformed. `1043` as a number is malformed too — coercion is interpretation, which is
  what this gate refuses to do.
- **Identifiers come from the database.** The model names an order number; the resolved proposal
  carries the order's own `_id` and canonical number, looked up within the caller's tenant *and*
  customer. Another customer's order and a nonexistent one are recorded identically.
- **Confirmation text is rendered from the record.** `renderConfirmText(actionType, order)` has no
  parameter through which model text could reach the dialog — a stronger guarantee than a rule
  saying it should not. Money is formatted using each currency's own minor unit, so a yen order is
  not off by a factor of a hundred.

### 4.1 Phase 3 made malformed attempts unrecordable

FR-4.3 requires a malformed proposal to be recorded. Phase 3's schema required `target.orderId`
unconditionally, so an attempt that never resolved to an order **could not be written at all**.
`ActionProposal` now carries a `validity` field and requires the resolved fields only when
resolved.

### 4.2 Codes, never messages

The boundary's problem messages echo model-supplied text — an unknown field name, an order number.
Storing them would put free text into an immutable row, which is unscrubbable by construction.
**The audit stores enumerated codes; the messages go to the logs, which rotate.** A test asserts
every code the validator can emit is one the schema accepts — a mismatch would lose the record in
exactly the case the record exists for. Recorded as an
[ADR 0006 amendment](../adr/0006-append-only-audit-retains-refusals.md#amendments).

---

## 5. Propose → confirm → execute

`actionService.js` owns the sequence and nothing else. Every read and write goes through an
injected repo, so the part most likely to be subtly wrong — ordering — is tested exhaustively,
including the cases a real database makes hard to reproduce on demand.

```
propose   shape ─▶ resolve ─▶ PERSIST proposal ─▶ evaluate ─▶ record decision
                                                     ├─ refuse            → outcome: refused_at_proposal
                                                     ├─ agent-only / other → outcome: escalated_at_proposal
                                                     └─ confirm-required  → pending (no outcome row)

confirm   recorded proposal-time decision ─▶ RE-EVALUATE now ─▶ record decision
                                                     ├─ no longer allowed → outcome: refused_at_execution (409)
                                                     └─ allowed           → execute atomically → outcome: executed
```

### 5.1 A pending proposal needed somewhere to keep its authorisation

A `confirm-required` proposal waits across **two HTTP requests**. At confirmation, ADR 0003 needs
the proposal-time decision. But the proposal row is written before evaluation and can never be
edited, and no outcome row may exist yet — a pending proposal is defined by having none.
Re-deriving the decision at confirm time is not possible either, because the rules may have
changed in between, which is ADR 0003's entire point.

So **each evaluation is recorded as its own immutable `PolicyDecision` row.** This reverses an
alternative Phase 3 rejected. Its unique index is *partial* — one proposal-stage decision per
proposal, but execution-stage decisions may repeat, because a confirmation that hit a version
conflict is legitimately retried. Recorded as an
[ADR 0003 amendment](../adr/0003-recheck-at-execution-and-idempotency.md#amendments).

### 5.2 What the tests exercise

| Scenario | Result |
|---|---|
| The order ships between proposal and confirmation | `refused_at_execution`, both decisions recorded, order untouched |
| A rule is edited between proposal and confirmation | the new rule applies; the recorded proposal-time decision is unchanged |
| The same confirmation is sent twice | the original result, executed once |
| Two confirmations race | exactly one execution; both callers see it |
| A version conflict during the write | nothing written, proposal still pending, a retry re-evaluates and succeeds |
| A fault during execution | terminal `failed` outcome, error **code** only, no re-execution |
| **The ambiguous commit** | see below |

**The ambiguous commit.** A transaction can commit and the driver still report an error — a
connection reset after the server applied the write. The service cannot tell from the error whether
the cancellation happened. But recording `failed` then hits the idempotency key, which already
holds the `executed` outcome, and the repo returns that row. **Idempotency turns "we don't know
whether it worked" into a question with an answer.**

The fake repo used by these tests enforces the same guarantees the real one must — a unique
idempotency key, atomic conditional execution — and can be told to misbehave the way a database
does. This project has already learned twice that a forgiving test double tests nothing.

---

## 6. The MongoDB repository

`mongoActionRepo.js` owns three database guarantees: tenancy in every query, once-only outcomes,
and atomic conditional execution.

**The cancellation is conditional on the facts the decision read, not only on the version.**
`__v` catches changes made through `save()`, but not another writer's plain `updateOne` that never
touches the version — a shipping integration marking an order dispatched, for instance. A
version-only guard would then cancel an order that had already shipped. The write therefore also
requires `status`, `totalMinor` and `currency` to be unchanged. *Known limit:*
`customer.orderCount90d` is derived from other orders and cannot be guarded by a condition on this
one.

**A version conflict may really be a duplicate.** If another confirmation of the same proposal
committed first, this transaction's snapshot predates it and cannot see the winner's outcome row.
The repo looks again outside the aborted snapshot before reporting a conflict.

**A malformed proposal id returns "not found" without a query.** A `CastError` would be a 500 whose
body differs from a 404's — an existence oracle.


### 6.1 The confirm route tells a customer nothing about policy

The stored outcome carries both policy decisions — rule keys, versions, matched conditions. That
is internal detail (ADR 0007), and returning the row as-is would hand every customer a map of
the policy boundary with every confirmation. So the response is built **field by field from an
allowlist** — proposal id, outcome, time, cancellation reference — rather than by deleting the
fields someone remembered to delete. A test checks that no rule key, decision or idempotency
key reaches the body.

Two more rules, both tested: every identifier comes from the **session**, so a request body
naming another customer or tenant is ignored; and the route is **customer-only**. ADR 0009 says
the customer confirms the exact action they were shown, so an agent cannot confirm on their
behalf here. An agent acting on an escalated case is a different path, with its own
authorisation, in Phase 11.

---

## 7. Corrections to earlier phases

| Correction | Recorded in |
|---|---|
| Precedence: evaluate every rule, most restrictive wins | [ADR 0004 amendment](../adr/0004-policy-as-data.md#amendments) |
| Malformed proposals are recordable, with codes rather than messages | [ADR 0006 amendment](../adr/0006-append-only-audit-retains-refusals.md#amendments) |
| Each evaluation is a `PolicyDecision` row; the write is conditional on facts | [ADR 0003 amendment](../adr/0003-recheck-at-execution-and-idempotency.md#amendments) |
| The Python suite's earlier green run was luck | [Phase 9 amendment](phase-09-kb-ingest-and-ai-service.md) |

---

## 8. Honestly unverified

All of the following needs a MongoDB **replica set**, and none has run against one:

- that the unique indexes are actually enforced — on the idempotency key, on the proposal, and the
  partial index on proposal-stage decisions;
- that the execution transaction commits or aborts as a unit, and that `withTransaction`'s
  automatic retry re-runs the callback safely;
- the whole route layer end to end: a customer proposing, confirming and seeing the result.

The repo tests use fake models. They assert the **shape** of every query and how database outcomes
are translated. They do not, and are not described as, proving what MongoDB itself does.

---

## 9. Still to build in this phase

- The `proposal` stream frame: the AI service emitting a proposal, Express validating it through
  the boundary above, and only then adding `proposal` to the frame allowlist Phase 9 deliberately
  closed.
- Policy administration: list rules split into baseline and tenant (ADR 0008); edits as new
  versions, including disabling. The Phase 6 contract has no route to *create* a rule, which
  FR-12.1 requires.
- The audit query: refusals included by default (FR-11.2), and malformed attempts included too,
  since "what did the assistant try to do that it was not allowed to do" covers them.
- A seed script for the baseline, demo tenants, customers and orders.
- The sweep that expires undecided proposals.
