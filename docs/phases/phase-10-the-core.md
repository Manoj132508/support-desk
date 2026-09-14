# Phase 10 — The core

**Project 3 · AI Support Desk**
Status: **in progress.** Built, tested and committed: the policy engine, the proposal boundary,
propose → confirm → execute with its MongoDB repository, the customer confirm and reject routes,
policy administration and the audit query. Still to build: the `proposal` stream frame and the
proposal source behind it, the customer conversation screen, the seed script and the expiry sweep
(§11). This document records findings as they are made rather than reconstructing them at the end.

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
  policyAdmin.js      rules as versions; the baseline locked; authoring-time validation
  mongoPolicyRepo.js  a new version and the old one's retirement, in one transaction
  auditQuery.js       attempts, refusals included by default, keyset pages
  mongoAuditRepo.js   one aggregation over attempts, with ids cast explicitly
server/src/db/models/audit.js   + PolicyDecision, + ActionProposal.validity/problemCodes/confirmText
server/src/routes/
  proposals.js        customer-only confirm and reject
  policies.js         leads read, admins change
  audit.js            leads and admins
```

Server suite: **311 tests**.

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

## 7. Policy administration

This is the only way a person changes what the assistant is allowed to do, so it is held to three
rules.

**Every change is a new version — including disabling a rule.** An edit writes the next version;
the old one keeps its content, and only its `active` flag flips. A past decision therefore stays
explainable against the exact rule version that made it (FR-12.2), and "who changed this, and
when" is answered by the version rows themselves. Rewording a disabled rule does not quietly switch
it back on.

**The platform baseline is locked to the API.** Leads can see it; an attempt to edit it is a 403.
A tenant can make any baseline rule stricter with a rule of its own — the ladder guarantees that —
but cannot relax one (ADR 0008). The version change and the old version's retirement commit in one
transaction, so there is never a moment with two active versions of a rule, or none.

**A rule that would behave unlike how it reads is refused when written.** The validator is
deliberately *stricter* than the schema and never looser — a test asserts that everything it
accepts, the schema and the engine accept too. The extra strictness targets rules that would save
cleanly and then mislead:

| Refused | Because |
|---|---|
| `eq` compared with a list | it can never match, so the rule would look active and do nothing |
| `auto-execute` | the engine would clamp it (FR-5.4), so the rule would do something other than it says |
| a customer message naming a rule key or a condition field | it hands the policy boundary to the customer (ADR 0007) |

Concurrency is handled at two levels: editing from an out-of-date screen is a 409, and two editors
writing the same next version are separated by the unique version index rather than one silently
overwriting the other.

**A gap in the Phase 6 contract.** It specified reading and editing rules but gave no way to
*create* one. FR-12.1 requires it, and ADR 0008's tenant layering cannot be demonstrated without a
tenant rule, so `POST /api/policies` is added.

---

## 8. The audit query

The query exists to answer the question that sells the project: *what did the assistant try to do
that it was not allowed to do?* Taking that seriously produced four decisions.

**The unit is the attempt, not the outcome.** The query runs over every `ActionProposal`, with its
outcome and proposal-time decision joined on where they exist. That puts attempts that never
reached the policy engine — including ones that tried to assert their own authorisation — into the
answer. `preset=stopped` asks exactly the question above, and deliberately leaves out customer
rejections: a customer declining is not the assistant being stopped.

**Refusals are in by default (FR-11.2).** Excluding them takes an explicit filter.

**An unrecognised filter is an error.** A lead who types `kinds=` instead of `kind=` must not get
back an unfiltered list they believe is filtered. For an audit, a silently ignored filter is a
misleading answer. A repeated parameter is refused too, rather than guessing which one wins.

**Pagination is keyset, not offset.** The log is append-only and grows at the top while someone is
paging. With `skip`, each new attempt pushes the next page down by one, so rows are shown twice or
never. A cursor meaning "strictly older than this row", with `_id` breaking ties inside one
millisecond, is unaffected by what arrives above it. A test adds an attempt between two pages and
checks that nothing is duplicated and nothing is skipped.

One implementation trap is worth recording: **an aggregation does not cast ids.** `find()` quietly
converts a string into an `ObjectId`; `aggregate()` does not, and a tenant id left as a string would
match nothing — an empty audit, and a baffling one. Every id is converted explicitly, and the tenant
condition is repeated inside each join, so a broken invariant elsewhere yields a missing join rather
than another tenant's decision.

---

## 9. Corrections to earlier phases

| Correction | Recorded in |
|---|---|
| Precedence: evaluate every rule, most restrictive wins | [ADR 0004 amendment](../adr/0004-policy-as-data.md#amendments) |
| Malformed proposals are recordable, with codes rather than messages | [ADR 0006 amendment](../adr/0006-append-only-audit-retains-refusals.md#amendments) |
| Each evaluation is a `PolicyDecision` row; the write is conditional on facts | [ADR 0003 amendment](../adr/0003-recheck-at-execution-and-idempotency.md#amendments) |
| The Phase 6 contract had no route to create a rule; `POST /api/policies` added | §7, and the route list in `routes/index.js` |
| The Python suite's earlier green run was luck | [Phase 9 amendment](phase-09-kb-ingest-and-ai-service.md) |

---

## 10. Honestly unverified

All of the following needs a MongoDB **replica set**, and none has run against one:

- that the unique indexes are actually enforced — on the idempotency key, on the proposal, and the
  partial index on proposal-stage decisions;
- that the execution transaction commits or aborts as a unit, and that `withTransaction`'s
  automatic retry re-runs the callback safely;
- that a new rule version and the retirement of the old one commit together, and that two editors
  writing the same next version are separated by the unique index;
- that the audit aggregation's `$switch` labels attempts exactly as `kindOf()` does. The two are
  written to mirror each other and a test checks the branch order, but only a real MongoDB can show
  they agree;
- the whole route layer end to end: a customer proposing, confirming and seeing the result.

The repo tests use fake models. They assert the **shape** of every query and pipeline, and how
database outcomes are translated. They do not, and are not described as, proving what MongoDB
itself does.

---

## 11. Still to build in this phase

- **The `proposal` stream frame.** The AI service sends a raw proposal upstream under its own event
  name; Express intercepts it and never relays it, runs it through the boundary and the engine
  above, and emits its *own* `proposal` or `policy` frame. The allowlist Phase 9 closed stays
  closed — the model's unvalidated proposal can never reach the browser, because it is never
  forwarded at all.
- **The proposal source while live inference is unavailable.** A deterministic, deliberately
  conservative intent recogniser in the AI service, documented plainly as *not* the model. It does
  not weaken INV-A: whatever arrives from the advisory tier is untrusted, whether a model, a regular
  expression or an attacker produced it.
- **The customer conversation screen** — the confirmation dialog and policy block from Phases 4–5,
  wired to those frames.
- **An index for the audit's sort** on `ActionProposal` — `(tenantId, createdAt, _id)`. The
  aggregation is correct without it and slow at scale without it.
- A seed script for the baseline, demo tenants, customers and orders.
- The sweep that expires undecided proposals.
