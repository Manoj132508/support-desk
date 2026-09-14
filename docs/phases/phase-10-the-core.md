# Phase 10 — The core

**Project 3 · AI Support Desk**
Status: **in progress — one item left.** Built, tested and committed: the policy engine, the
proposal boundary, propose → confirm → execute with its MongoDB repository, the confirm and reject
routes, policy administration, the audit query, the proposal stream frame and the recogniser
behind it, the demo seed and the expiry sweep. Still to build: the customer conversation screen
(§14). This document records findings as they are made rather than reconstructing them at the end.

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
  proposalFrames.js   what a customer's stream is told about a proposal
  policyAdmin.js      rules as versions; the baseline locked; authoring-time validation
  mongoPolicyRepo.js  a new version and the old one's retirement, in one transaction
  auditQuery.js       attempts, refusals included by default, keyset pages
  mongoAuditRepo.js   one aggregation over attempts, with ids cast explicitly
  expirySweep.js      undecided proposals expire, tenant by tenant
  mongoSweepRepo.js   what "pending" means, as a pipeline
server/src/services/sse.js      the relay: an allowlist, and the one intercepted frame
server/src/routes/              proposals.js · policies.js · audit.js · conversations.js
server/scripts/                 seedData.js (pure) · seed.js · sweep.js
ai-service/app/pipeline/intent.py   recognising a request to act, conservatively
```

Tests: **355 server**, **78 AI service**, 39 client.

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
checks that nothing is duplicated and nothing is skipped. An index on `(tenantId, createdAt, _id)`,
in exactly the order the pipeline sorts, serves it.

One implementation trap is worth recording: **an aggregation does not cast ids.** `find()` quietly
converts a string into an `ObjectId`; `aggregate()` does not, and a tenant id left as a string would
match nothing — an empty audit, and a baffling one. Every id is converted explicitly, and the tenant
condition is repeated inside each join, so a broken invariant elsewhere yields a missing join rather
than another tenant's decision.

---

## 9. The proposal stream frame

This is where Phase 9's closed frame allowlist meets a real proposal, and **the allowlist stays
closed**.

The AI service sends a raw proposal upstream as **`proposal_request`**. The relay in `sse.js` does
not forward it: it hands it to a handler that runs `actionService.propose` — boundary, resolution,
record, evaluate — and only the *result* reaches the customer, as a `proposal` frame for
confirmation or a `policy` notice.

**The two names differ on purpose.** If both were `proposal`, a relay that forwarded proposal frames
would be one mistaken line away from letting the model open its own confirmation dialog. With
different names, nothing forwards `proposal_request` and nothing upstream may send `proposal`, so
they cannot connect even by accident. The AI service's tests check that it never emits `proposal`
at all.

Four further rules, all tested:

- **Customer frames are built from an allowlist** (`proposalFrames.js`): no rule keys, versions,
  matched conditions, problem codes or internal reasons. A malformed attempt tells the customer
  nothing about why.
- **At most one proposal per turn** — ADR 0009 property 7, one proposal, one dialog. A second
  request in the same turn is dropped rather than stacked.
- **Only a customer's own turn may raise a proposal.** On a staff turn the request is dropped like
  any unaccepted frame.
- **A failure mid-turn aborts the upstream request**, rather than leaving the model generating
  tokens behind a closed stream.

The confirm result carries the action type and order number from the **recorded** proposal, so the
dialog's button names the order as the database knows it, not as it was typed.

---

## 10. The proposal source, while inference is unavailable

The natural proposer is the model, through tool calls. Live inference is blocked on this machine
by a GPU fault, so proposals come from **a deterministic recogniser, `intent.py`, and the
documentation says so** rather than implying a model decided anything.

That does not weaken INV-A at all, which is the architecture's point: Express treats whatever
arrives from the advisory tier as an untrusted request. A model, a regular expression, or an
attacker who compromised that process are held to the same boundary, engine and confirmation.

**It is tuned not to propose.** A missed request gets an ordinary grounded answer — mildly
unhelpful, entirely safe. A false proposal puts a confirmation dialog in front of someone who only
asked a question. So negation always wins; a question *about* cancelling never proposes, even with
an order number in it; and a request naming no order **asks which one** rather than guessing,
which is FR-4.2 exactly.

**On an action turn the model is never called.** The assistant's words are static. A model asked to
phrase "let me check that order" is a model that can phrase "done, I've cancelled it".

Two test-writing lessons came out of this, both about tests that looked right:

- The first check that the assistant never claims an action happened banned the bare word
  "cancelled" — and so rejected *"Let me check whether order 1043 can be cancelled"*, a sentence
  that describes a condition and claims nothing. The checker now matches claim *phrases*, and has
  tests of its own, including sentences it must catch.
- The first test that a grounded proposal carries evidence picked a sentence and assumed the fake
  embedder would ground it. It did not. The rule under test is "evidence only when grounded", so the
  threshold is now forced and the rule checked in both directions. How a real model grounds action
  phrasings is a question for the Phase 13 eval.

---

## 11. The demo seed and the expiry sweep

### 11.1 A demo that can be reproduced, and checked

A demo is only evidence if a reviewer can reproduce it. `buildSeedData` is a pure function, so it is
checked without a database: every document is validated against its real schema, and **the policy
engine is run over the seeded orders** to confirm the demo shows what it claims — a confirmable
cancellation (1043), an order that becomes a refusal once dispatched mid-flight (1042), and a
high-value order caught by a tenant rule stricter than the baseline (1047). Every order status is
present, and two orders exist only to be unreachable: another customer's, and another tenant's.

The seed is **never destructive** — upserts on natural keys, insert-only fields, deterministic ids —
and it **refuses to run in production**, because the demo accounts share a published password.
`npm run seed -- dispatch 1042` marks an order dispatched with a **plain update that never bumps the
version**, reproducing exactly the change §6's facts-conditional write guards against.

Writing it exposed that `npm run dev` had never loaded `server/.env`, although the Phase 6 config
comment said it did. And its first schema test failed on valid data: it passed each rule through
`structuredClone`, which turns an `ObjectId` into a plain object holding bytes — a value that prints
like an id but has lost its type, the same family of bug as the aggregation that does not cast.

### 11.2 Proposals nobody decided

A dismissed dialog leaves a proposal pending forever. The sweep gives it the terminal outcome
`expired`, a non-execution (ADR 0009 property 5).

- **The TTL is hygiene, not safety.** ADR 0003 already rejected a TTL as the protection against
  stale facts — it narrows the window without closing it. The execution-time re-check is what makes
  a late confirmation safe.
- **Tenant by tenant.** One query over every tenant's proposals would be a second deliberate
  cross-tenant business query, after the policy loader ADR 0008 names as the only one. The sweep
  lists tenants — unscoped by nature — and does every business read and write inside one tenant.
- **A proposal that was never offered is skipped**, rather than recorded as a customer walking away.
- **A race with a confirmation is settled by the idempotency key**, because both record their outcome
  through the same repository code and the same unique index. The sweep overwrites nothing.
- `npm run sweep` is for the host scheduler, not a timer inside the API, which would run once per
  instance.

---

## 12. Corrections to earlier phases

| Correction | Recorded in |
|---|---|
| Precedence: evaluate every rule, most restrictive wins | [ADR 0004 amendment](../adr/0004-policy-as-data.md#amendments) |
| Malformed proposals are recordable, with codes rather than messages | [ADR 0006 amendment](../adr/0006-append-only-audit-retains-refusals.md#amendments) |
| Each evaluation is a `PolicyDecision` row; the write is conditional on facts | [ADR 0003 amendment](../adr/0003-recheck-at-execution-and-idempotency.md#amendments) |
| The Phase 6 contract had no route to create a rule; `POST /api/policies` added | §7, and the route list in `routes/index.js` |
| The Phase 6 config said `npm run dev` loaded `.env`; it did not | §11.1, and `server/package.json` |
| The Python suite's earlier green run was luck | [Phase 9 amendment](phase-09-kb-ingest-and-ai-service.md) |

---

## 13. Honestly unverified

All of the following needs a MongoDB **replica set**, and none has run against one:

- that the unique indexes are actually enforced — on the idempotency key, on the proposal, and the
  partial index on proposal-stage decisions;
- that the execution transaction commits or aborts as a unit, and that `withTransaction`'s
  automatic retry re-runs the callback safely;
- that a new rule version and the retirement of the old one commit together, and that two editors
  writing the same next version are separated by the unique index;
- that the audit aggregation's `$switch` labels attempts exactly as `kindOf()` does, and that the
  sweep's pipeline selects exactly the pending proposals. Both are written to mirror their
  JavaScript counterparts and tested for structure, but only a real MongoDB can show they agree;
- the seed and sweep scripts themselves — their pure cores are tested, the wrappers are not;
- the route layer end to end: a customer's message reaching the AI service, the proposal being
  intercepted, confirmed and executed, and the result shown.

The repo tests use fake models. They assert the **shape** of every query and pipeline, and how
database outcomes are translated. They do not, and are not described as, proving what MongoDB
itself does.

---

## 14. Still to build in this phase

- **The customer conversation screen.** The confirmation dialog and policy block from Phases 4–5,
  wired to the `proposal`, `policy`, `token`, `evidence` and `done` frames, with the transcript
  built by a pure reducer so the rule that matters is testable: **only a server decision can mark an
  order cancelled** — no stream frame can.

One limit to state in advance: escalation to a person is Phase 11 (FR-8). Until then a policy notice
cannot offer "talk to a person", and ADR 0007 says a refusal should always offer a next step. The
screen will show the rule's own message and **no escalation button**, rather than a button that
does nothing — and this gap closes in Phase 11.
