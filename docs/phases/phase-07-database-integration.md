# Phase 7 — Database integration

**Project 3 · AI Support Desk**
Status: complete, with one caveat stated up front — **no live Atlas connection has been made
yet**, because there is no connection string on this machine. Everything below is written and
tested; §6 says exactly what remains unverified.

---

## 1. What exists now

```
server/src/
  db/
    connect.js                 Atlas connection + the transaction pre-flight check
    tenantScope.js             INV-D, applied in the query
    plugins/immutable.js       INV-B, append-only enforcement
    models/
      core.js                  Tenant · User · Customer · Order · Conversation · Message · Ticket
      audit.js                 PolicyRule · ActionProposal · ActionOutcome · TicketEvent
      index.js
  domain/
    ticketState.js             FR-9, a pure state machine
```

**63 server tests** (up from 18), **102 across the project**, all green.

---

## 2. Testing a database layer without a database

Every assertion in this phase runs offline, and that is a design property rather than a
limitation forced by the missing connection string.

| Concern | How it is tested without connecting |
|---|---|
| Immutability | Mongoose runs query middleware **before** it contacts the server, so the plugin's refusal is observable with no connection |
| Tenancy | `scoped()` is handed a fake model that records the filter it receives — the assertion is about **the shape of the query**, not what came back |
| Schema rules | `validateSync()` is entirely local |
| Indexes | `schema.indexes()` is a declaration, readable without a server |
| State machine | A pure module with no I/O |

`bufferCommands` is disabled in the immutability suite deliberately: if a write ever got *past*
the plugin, it would fail with a connection error rather than hanging for ten seconds and
looking like a pass.

The tenancy test is the one worth studying. It asserts the **filter that was built**, because a
post-fetch authorisation check would pass a behavioural test and still leak — it fetches the
foreign record first, and only then decides.

---

## 3. Three decisions

### 3.1 Immutability blocks `validate`, not just `save`

The obvious implementation blocks `save()` on a document where `isNew` is false. It does not
work well: Mongoose registers field validation as its own pre-save hook, before any plugin's, so
editing a loaded audit row reported *"tenantId is required"* — a validation complaint about an
operation that was never permitted in the first place.

Blocking at `pre('validate')` as well puts the real reason first. **Whether the edited document
would have been valid is beside the point; the edit is forbidden.**

Deletes are blocked too. "Append-only" that permits deletion is not append-only, and the
deletion-request path does not need it — de-identification scrubs `Customer` and leaves audit
rows untouched.

### 3.2 Tenancy is a surface, not a habit

`scoped(Model, ctx)` returns a narrow API where the tenant filter is not something you remember
to add — it is the only way to build a query.

A missing tenant context **throws** rather than falling back. This matters more than it looks:
`{ tenantId: undefined }` matches documents where the field is absent, so a silent fallback
would be a cross-tenant read wearing a bug's clothing.

A caller-supplied `tenantId` — from a body or a query string — cannot override the context,
because the context is applied last. There is a test for exactly that.

`policyScopeFilter()` is the **one deliberate exception** (ADR 0008): `{ $in: [tenantId, null] }`
to load tenant rules plus the platform baseline. Read-only, confined to one function, and named
so it reads as a decision rather than as the oversight it would otherwise look like to anyone
grepping for tenancy violations.

### 3.3 The connection fails at startup, not at the first cancellation

`connectDatabase()` opens a session, starts a transaction and aborts it.

If the deployment is pointed at a standalone `mongod`, every read works, every insert works, and
the *one* operation that matters — executing an action inside a transaction — fails. That
failure would arrive in production, on the only route that mutates business data, which is the
worst possible place to discover a configuration mistake. So the process refuses to start
instead, with an error naming the fix.

`strictQuery` is on for a related reason: a filter naming a field absent from the schema would
otherwise be **silently dropped**, and a dropped `tenantId` is a cross-tenant read. The
permissive default is a security setting in disguise.

---

## 4. What testing changed

### 4.1 A real bug: evidence was being dropped in silence

`ActionProposal.evidence` was an inline array. Adding a `snippet` field to an entry made
Mongoose **discard the entire evidence entry** — the proposal would have saved with zero
evidence, no error, and nobody told.

In the collection whose job is to prove what happened, silently losing evidence is a far worse
failure than refusing a write. The fix is an explicit `evidenceRefSchema` with `strict: 'throw'`,
so a snippet now produces a validation error on `evidence` and the proposal cannot be persisted.
**Loud beats silent**, and there is a test named for it.

This is the same instinct as Phase 6's stack-trace fix and Phase 4's error affordances: a system
that hides a problem trains people not to look.

### 4.2 A specification inconsistency, resolved

FR-13.4 says deletion "cascades across conversations, messages, and tickets". Phase 3 §7 listed
`Message` and `Conversation` as deleted and did not mention `Ticket` at all.

Resolved here: **`Ticket` is retained and scrubbed, not deleted.** A ticket is the anchor its
immutable `TicketEvent` rows point at, and deleting it would orphan the audit trail those events
constitute. Scrubbing — nulling the free-text `note` — satisfies the intent by the same
mechanism used for `Customer`, and keeps the events resolvable.

This also drove a schema decision: **agent-authored free text lives on the mutable
`Ticket.note`**, while `TicketEvent.reason` is an **enum**. That removes the residual privacy
risk Phase 3 §7 named — free text in an immutable row that can never be scrubbed — for
system- and assistant-generated events.

---

## 5. Schema details worth naming

- **`tenantId` leads every compound index.** ADR 0005 puts tenancy in every filter, so it
  belongs first in every index: the correct thing is also the fast thing.
- **Money is an integer with a validator that rejects floats.** `order.totalMinor` is a policy
  condition operand; a float comparison varying across platforms would make the one component
  whose determinism the project's central claim rests on non-deterministic.
- **`order.ageHours` is a method, not a field** — derived at evaluation, so a rule cannot be
  decided against a stale age. A test asserts the schema path does not exist.
- **`Order` uses optimistic concurrency.** Execution makes the cancelling update conditional on
  the version, closing the gap between *deciding* and *writing* — the companion to ADR 0003's
  re-check, which closes the gap between *proposing* and deciding.
- **`PolicyRule` conditions are validated against the registry at save time.** A bad rule sitting
  in the database looking fine until it is asked to decide something is the worst possible time
  to find out.
- **`PolicyRule` is not under `immutablePlugin`**, because the `active` flag flips when a version
  is superseded. Versions are immutable in *content*; the flag is bookkeeping. Named here so the
  inconsistency reads as a decision.

---

## 6. Honestly unverified

Everything above is tested offline. These need a live Atlas cluster and are **not yet proven**:

- The connection itself, and the transaction pre-flight check actually passing.
- Unique index enforcement — `idempotencyKey`, `proposalId`, `(tenantId, ruleKey, version)`,
  `(tenantId, ticketId, seq)`. The declarations are asserted; the **enforcement** is a database
  behaviour and needs one.
- `writeConcern: majority` behaviour.
- Query performance against the declared indexes.

Set `MONGODB_URI` in `server/.env` and these become checkable. Until then `/api/health` reports
`database: "unconfigured"`, which is the honest answer rather than a hopeful one.

---

*Phase 7 complete. Phase 8 builds authentication: registration, login, the httpOnly session
cookie with CSRF double-submit ported from Project 2, role middleware for the four roles, and
the tenant context that `scoped()` already requires.*
