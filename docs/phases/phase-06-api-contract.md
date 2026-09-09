# Phase 6 — Backend API contract

**Project 3 · AI Support Desk**
Status: complete. Turns FR-1…FR-14 into a contract, and ships the Express skeleton that
enforces its shape. No database (Phase 7), no auth (Phase 8), no policy engine (Phase 10).

---

## 1. Why a contract phase at all

The client already exists and already makes assumptions: `api.js` expects a four-kind error
envelope, and `useEventStream.js` already parses named SSE frames. Those assumptions were
invented in Phase 5 and must now become an agreement, or the two halves drift and the drift is
discovered at integration time.

So this phase writes the contract down and ships a server that **enforces its shape while
returning `501 Not Implemented` for behaviour later phases provide**. Every route exists, every
route is correctly shaped, and none of them lie about being finished.

---

## 2. The error envelope

Every non-2xx response, without exception, is this object:

```json
{
  "kind": "refused",
  "message": "Cancellation is not permitted after dispatch",
  "customerMessage": "This order has already shipped, so I can't cancel it from here.",
  "detail": { "ruleKey": "POL-CANCEL-DISPATCHED", "ruleVersion": 2, "matched": ["order.status"] },
  "correlationId": "c8f1a2e4-..."
}
```

| Field | Audience | Always present |
|---|---|---|
| `kind` | Client rendering logic | yes |
| `message` | Logs, developers | yes |
| `customerMessage` | The customer (ADR 0007) | only when a rule authored one |
| `detail` | **Internal surfaces only** — agent console, audit | only for staff roles |
| `correlationId` | Support and debugging | yes |

**`detail` is stripped for customer-role callers by the error middleware**, not by each route.
ADR 0007 keeps the two channels separate at the data layer; this keeps them separate at the
transport layer, so a route cannot leak a rule id by forgetting.

### 2.1 Status code mapping

| `kind` | Status | Meaning |
|---|---|---|
| `malformed` | **422** | The request or a model proposal was not shaped correctly |
| `refused` | **403** | A policy rule declined it |
| `stale` | **409** | It was valid, and no longer is (ADR 0003) |
| `fault` | **500** | Something broke |
| `fault` | **404** | Not found — see below |

**Why 404 carries `fault` and a generic body.** INV-D requires a record in another tenant to be
indistinguishable from one that does not exist. If a 404 carried a policy `kind` or a
`customerMessage` explaining anything, the response would differ between the two cases and the
isolation would leak through the error body. So every 404 is byte-identical and says nothing.

**Why a refusal is a 4xx and not a 200 with a negative body.** The confirm endpoint returns
**200 only when the action executed**. The client asked for something to happen; if it did not,
the transport should say so rather than making every caller inspect a body to find out whether
their order was cancelled. The body still carries the full outcome so the UI can render the
policy language — the status says *whether*, the body says *why*.

---

## 3. Endpoints

`404` and the error envelope apply to all of them. `✱` marks routes returning `501` until the
phase named.

### 3.1 Auth — FR-13 *(Phase 8)*

| Method | Path | Body | 2xx |
|---|---|---|---|
| POST | `/api/auth/register` ✱ | `{ email, password, name }` | `201 { user }` |
| POST | `/api/auth/login` ✱ | `{ email, password }` | `200 { user }` + session cookie + CSRF cookie |
| POST | `/api/auth/logout` ✱ | — | `204` |
| GET | `/api/auth/me` ✱ | — | `200 { user }` / `401` |

`user` is `{ id, email, name, role, tenantId }`. The token is never in a body — it is an
httpOnly cookie, and the CSRF cookie is the readable half of the double-submit pair.

### 3.2 Conversations — FR-1, FR-2, FR-3 *(Phases 9–10)*

| Method | Path | 2xx |
|---|---|---|
| POST | `/api/conversations` ✱ | `201 { conversation }` |
| GET | `/api/conversations/:id` ✱ | `200 { conversation, messages }` |
| POST | `/api/conversations/:id/messages` ✱ | `200 text/event-stream` — §4 |

### 3.3 Proposals — FR-6, FR-7 *(Phase 10)*

| Method | Path | 2xx | Notes |
|---|---|---|---|
| POST | `/api/proposals/:id/confirm` ✱ | `200 { outcome }` | **The only route that mutates business data** |
| POST | `/api/proposals/:id/reject` ✱ | `200 { outcome }` | Writes `rejected_by_customer` |

**No `Idempotency-Key` header.** The key is derived server-side from the proposal id (ADR 0003)
because one proposal must execute at most once, and a client-supplied key would be
attacker-controlled and would express a weaker rule.

Confirm responses:

| Situation | Status | Body |
|---|---|---|
| Executed | 200 | `{ outcome: "executed", result }` |
| Duplicate confirmation | 200 | The original result, unchanged |
| Policy now refuses | **409** | `kind: "stale"`, both decisions |
| Already rejected or expired | 409 | `kind: "stale"` |
| Not the caller's proposal | 404 | Generic |

### 3.4 Tickets — FR-8, FR-9, FR-10 *(Phase 11)*

| Method | Path | 2xx |
|---|---|---|
| GET | `/api/tickets?status=` ✱ | `200 { tickets, page }` |
| GET | `/api/tickets/:id` ✱ | `200 { ticket, events, conversation }` |
| POST | `/api/tickets/:id/status` ✱ | `200 { ticket }` — illegal transition ⇒ **422** |
| POST | `/api/tickets/:id/escalate` ✱ | `200 { ticket }` |

An illegal transition is `malformed`, not `refused`. No policy rule declined it; the request
was not a valid move in the state machine. Keeping those distinct matters — one is a business
decision, the other is a bad request, and conflating them would put state-machine bugs in the
policy audit.

### 3.5 Policy and audit — FR-11, FR-12 *(Phase 10)*

| Method | Path | Roles | 2xx |
|---|---|---|---|
| GET | `/api/policies` ✱ | lead, admin | `200 { baseline, tenant }` — separated per ADR 0008 |
| PUT | `/api/policies/:id` ✱ | admin | `200 { rule }` — creates a new **version** |
| GET | `/api/audit` ✱ | lead, admin | `200 { entries, page }` |

`GET /api/audit` **includes refusals by default** (FR-11.2). Excluding them requires an explicit
filter. The default answers the question the project exists to answer.

### 3.6 Health — FR-14.1 *(live now)*

`GET /api/health` → `200` when the API is up, reporting each dependency **independently**:

```json
{ "status": "degraded", "api": "ok", "database": "unconfigured", "aiService": "unreachable" }
```

`status` is `ok` only when everything is. It is deliberately **not** a 503 when the AI service
is down: the desk still serves tickets, history and the console (FR-14.3), so reporting the
whole API as unhealthy would take a working system out of a load balancer.

---

## 4. SSE frame contract

`POST /api/conversations/:id/messages` streams `text/event-stream`. The client's `parseFrames`
already handles the wire format; this fixes the event names and payloads.

| Event | Payload | When |
|---|---|---|
| `token` | `"..."` | Each generated fragment |
| `evidence` | `{ kind, ref, snippetRef }` | A citation or tool result is attached |
| `proposal` | `{ id, actionType, target, confirmText }` | Policy returned `confirm-required` |
| `policy` | `{ kind, customerMessage, detail? }` | Policy refused or escalated |
| `done` | `{ messageId, outcome? }` | Turn finished normally |
| `error` | `{ kind, message }` | Turn failed — `fault` only |

Four rules that fall out of earlier decisions:

1. **`confirmText` is rendered server-side from the stored proposal**, never from model output
   (FR-6.1). It is the exact string the dialog displays and the string persisted as
   `confirmedText`.
2. **A `policy` frame is not an `error` frame.** `error` carries only `fault`. Sending a refusal
   as `error` would push it into the client's fault language and undo Phase 4 §5.
3. **`evidence` carries references, not snippets** — the constraint from ADR 0006's amendment.
4. **Cancellation is a client disconnect.** There is no `cancel` frame; the server observes the
   closed connection, stops generating, and persists the partial turn as cancelled (FR-1.3).

---

## 5. Cross-cutting

**Correlation id.** Every request gets one — echoed from `X-Correlation-Id` if the caller sent
one, otherwise generated. It is returned on every response, included in every error envelope,
and forwarded to the AI service. Without it the process boundary that provides the safety also
destroys the debuggability.

**Rate limits** (NFR-3): auth routes and the confirm route. The confirm route is limited because
it is the only mutating route, and a burst there is either a bug or an attack.

**Body size** capped at 64 kB. A support message is not a file upload.

**No API version segment.** `/api/...`, not `/api/v1/...`. There is one client, shipped from
this repo, and a version segment nobody increments is decoration. Breaking changes are recorded
in this document.

---

## 6. What the skeleton actually does

`server/` runs now:

- **`app.js` is a factory that returns an app without listening**, so tests import it and bind
  to port 0. No fixed test port, no cleanup races, no `supertest` dependency.
- Correlation id, `helmet`, JSON body limit, cookie parsing, rate limits — all live.
- Every route above is mounted and returns a correctly shaped `501` envelope.
- `/api/health` is real.
- The 404 handler and the error envelope are the last middleware, so nothing escapes them.

**18 tests** (`node:test`) assert the contract itself: the envelope shape, the status mapping,
that `detail` is stripped for customer callers, that 404s are byte-identical, and that every
declared route is mounted.

`CONTRACT_ROUTES` is exported as data and the mount test iterates it, so this document, the
router and the test cannot drift apart in three directions.

### 6.1 One thing running the code changed

The first green run printed **fourteen full stack traces** — one per unbuilt route. `501` was
built on `KIND.FAULT`, and faults log stacks because faults are bugs. But a `501` on a route a
later phase builds is a *known, deliberate state*, not a bug.

So `AppError` gained an `expected` override, and `notImplemented` and `notFound` set it. It is
the same failure mode as rendering a policy refusal as a red error toast, one layer down: **a
log that cries wolf on purpose teaches everyone to stop reading it.** Now asserted by a test so
it cannot regress.

---

## 7. What Phase 6 did not decide

- **Validation schemas per route** — Phase 7, alongside the Mongoose models they mirror.
- **The AI service's internal contract** — Phase 9, when there is something to call.
- **Pagination cursor format** — Phase 10, with the first endpoint that needs it.
- **Auth cookie flags in production** — Phase 8.

---

*Phase 6 complete. Phase 7 integrates the database: the eleven collections from Phase 3 as
Mongoose models, the `immutablePlugin` from ADR 0006, tenancy applied by query shape (ADR 0005),
and the Atlas connection.*
