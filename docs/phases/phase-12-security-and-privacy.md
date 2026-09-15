# Phase 12 — Security and privacy

**Project 3 · AI Support Desk**
Status: **in progress.** Delivers NFR-3 (security) and NFR-4 (privacy), and FR-13.4 (account
deletion), which the traceability table gave to Phase 8 and no phase built. This document records
findings as they are made rather than reconstructing them at the end.

---

## 1. Scope

The requirements, as Phase 1 wrote them:

- **NFR-3** — an OWASP top-10 pass on the mutating route; rate limiting on auth and on the confirm
  endpoint; no secrets in the repo.
- **NFR-4** — customer data never sent to the AI service beyond what the turn requires; the audit
  retention rule documented (FR-13.4).

The method was a review, not a scanner. Every route, the auth and session code, both tiers'
configuration, the AI service's endpoints and the history of the repository were read against those
requirements. Each finding below was confirmed in the code — and, where it could be, demonstrated —
before it was fixed, and each fix has a test.

---

## 2. Before building

Integrity first: `git fsck` clean, the working tree clean, and every suite green — server 455,
client 115, AI service 78.

---

## 3. Findings

| # | Finding | Class | Fixed by |
|---|---|---|---|
| 1 | **Login found the user by email alone.** Emails are unique per tenant, so one address could hold two accounts and login took whichever the database returned first. The only query made before sign-in, and the only one without a tenant | A01, A07 · INV-D | The organisation is part of the credentials; the user is found within it (`auth/login.js`) |
| 2 | **An unexpected error's message was sent to the caller** — a driver error quoting the value that broke a unique index, a cast error naming a model | A05 | Unexpected errors answer "Something went wrong"; the real message goes only to the log |
| 3 | **A malformed id was a 500**, not a 404: `GET /api/conversations/abc` returned *Cast to ObjectId failed … for model "Conversation"* | A05 | `scoped()` answers a malformed id as not found, before any query |
| 4 | **Session tokens were not pinned to an algorithm.** Demonstrated: an HS512 token signed with the secret was ACCEPTED by the old `verify` | A02 | HS256 pinned when signing and verifying |
| 5 | **The AI service accepted every caller when its token was unset** — in every environment | A05, A07 | In production it refuses to start without a 32-character token, and refuses every call if the setting disappears |
| 6 | **The AI service's `/ingest` read a filesystem path from the request**, so a caller could have it index a directory of their choosing, which retrieval would then quote to customers | A01 | It reads the configured help centre only |
| 7 | **Nothing stopped an unsafe production deployment**: an empty `JWT_SECRET` or AI token would run | A05 | The API refuses to start in production without strong secrets, a database and an AI service URL; the problems name variables, never values |
| 8 | **The message and escalate routes were unlimited**, though each message costs an AI call; the confirm limiter keyed on the client's address; and every 429 and CSRF rejection logged a full stack trace | API4, A09 | Per-user limits on confirm, messages, escalation and account deletion; rejections are expected, and logged once as a structured security event without the client's address |
| 9 | **More customer text reached the AI service than it used — and the wrong text.** The route read a conversation's *first* twenty messages and dropped the last, assuming it was the question; the prompt uses the last six | NFR-4 | The latest six messages, customer and assistant text only (`services/turnPayload.js`), with a test that reads the window from the AI service's own source |
| 10 | **react-router 6.30 carries an open-redirect advisory** (a backslash in `navigate`), and the login page navigated to a destination taken from the address the visitor arrived at | A01, A06 | The destination is checked (`lib/safeRedirect.js`). The fix upstream is in version 7 — see §7 |
| 11 | **Account deletion (FR-13.4) was designed in Phases 3 and 7 and never built** | NFR-4 | Built — §5 |
| 12 | **"No secrets in the repo" was a sentence, not a check**, and `.env.example` listed `AI_SERVICE_TOKEN` twice | NFR-3 | A test scans the working tree for keys, credentialed URIs and filled-in secret settings; the example documents one variable read by both tiers |

History was checked too: no file that looks like a secret, and no credential-shaped string, has
ever been committed. The one match was a placeholder local connection string in a comment.

---

## 4. OWASP top 10 on the mutating route

`POST /api/proposals/:id/confirm` is the only route that changes business data.

| | How the route answers it | Evidence |
|---|---|---|
| **A01** Broken access control | Customers only. The proposal is loaded within the tenant *and* the customer, so anyone else's is a 404. Every identifier comes from the session. A proposal never offered for confirmation cannot be confirmed | `proposalsRoute.test.js`; `actionService.test.js` (INV-D, malformed and refused proposals) |
| **A02** Cryptographic failures | Session in an httpOnly, SameSite=Strict cookie, Secure in production. JWT HS256 pinned, issuer checked, twelve-hour lifetime. bcrypt cost 12. Production refuses secrets under 32 characters | `auth.test.js`; `securityHardening.test.js` |
| **A03** Injection | The only input is the path id, validated as an ObjectId before any query; the body is not read. `strictQuery` is on. Login reads only strings | `mongoActionRepo.test.js`; `login.test.js` |
| **A04** Insecure design | INV-A: the model cannot reach this decision. Policy is re-checked at execution (ADR 0003), the idempotency key is derived by the server, and the write is conditional on the facts the decision read | `actionService.test.js` (ADR 0003 cases) |
| **A05** Security misconfiguration | Helmet headers, `x-powered-by` off, a 64 kB body limit. Errors carry no stack and no unexpected message; rule detail is stripped for customers. Unsafe production configuration will not start | `contract.test.js`; `securityHardening.test.js` |
| **A06** Vulnerable components | `npm audit` of production dependencies: server none; client two moderate react-router advisories — the open redirect mitigated (finding 10), the other in server-side rendering, which this app does not use. Python dependencies not audited (§7) | Phase 12 audit run |
| **A07** Authentication failures | Auth rate-limited; one 401 for every failure, with the bcrypt cost paid either way; sign-in within a tenant; role and tenant loaded fresh on every request; confirm rate-limited per user | `auth.test.js`; `login.test.js`; `rateLimit.test.js` |
| **A08** Integrity failures | CSRF double-submit with a timing-safe comparison, plus SameSite=Strict. The confirmed text is rendered by the server from the stored proposal and recorded as confirmed. The audit is append-only | `auth.test.js`; `immutable.test.js`; `actionService.test.js` (FR-6.1) |
| **A09** Logging and monitoring failures | Correlation ids end to end. Execution faults logged by code. CSRF rejections and rate limits logged as one event each. Every attempt, refusals included, in the audit. No alerting — a deployment concern | `rateLimit.test.js`; `securityHardening.test.js` |
| **A10** Server-side request forgery | The route makes no outbound request. The API's only outbound call, to the AI service, uses a URL from configuration, never from a request | `turnPayload.test.js` |

---

## 5. Account deletion, and the retention rule (FR-13.4, NFR-4)

`POST /api/account/delete` — customers only, below the authentication and CSRF line, rate limited
per user, and it **asks for the password again**: a session alone should not be able to erase
someone. In one transaction:

| | What | Why |
|---|---|---|
| **Deleted** | The user (credentials, email); the customer's conversations and every message in them | Free text, and not audit |
| **Scrubbed** | The customer profile's name, email and external reference, keeping its id; tickets' agent notes | Audit rows still point at the id. A ticket anchors its immutable events (Phase 7), and its note is its only free text |
| **Untouched** | `ActionProposal`, `ActionOutcome`, `PolicyDecision`, `TicketEvent` | They hold references and codes, never free text (ADR 0006), so afterwards they still show what was decided — without the person |
| **Retained** | Orders | Business records with no personal text |

The customer's page says what is removed and what is kept, in those terms — including that the
record of actions on their orders is not deleted, and why. Staff accounts are not deleted this way:
a staff id is on every event its owner made, and removing one is an administrator's decision. That
path is not built.

**The retention rule.**

| Data | Kept for | Ends |
|---|---|---|
| User, customer profile, conversations, messages | As long as the account exists | Account deletion. No time-based expiry is built |
| Tickets | Indefinitely | Notes scrubbed on account deletion |
| Audit rows | Indefinitely, de-identified by construction | Never. Retention windows remain future work, and would themselves need auditing (ADR 0006) |
| Orders | Indefinitely | — |
| Logs | The deployment's rotation, not set by this repository | Logs carry ids, counts and correlation ids. The one exception is `proposal_malformed`, whose problem messages can echo text the model produced |

---

## 6. What crosses to the AI service (NFR-4)

For each turn: the customer's question; at most the six most recent earlier messages, as role and
text, customer and assistant only; a correlation id; and the service token in a header. Never a
name, an email, a customer or tenant id, or an order record. The AI service finds order numbers in
the question's own text and never receives the order.

What cannot be minimised further is the customer's own words: a question has to be sent to be
answered, and whatever the customer chose to type in it travels with it.

---

## 7. Honestly unverified, and deferred

- **The deletion transaction** against a real replica set, like every transaction before it.
- **Rate limits are counted per process.** The limiter keeps its counts in memory, so behind
  several API instances each counts separately. Phase 15 either shares the store or states the
  multiplier.
- **Python dependencies were not audited**: `pip-audit` is not installed here.
- **react-router 7.** The advisory's fix is a major upgrade, deferred rather than taken inside a
  security phase without a way to test the whole client in a browser against a real API. The
  mitigation covers the login redirect, the one place a destination comes from outside the app.
- **Content Security Policy for the client.** Helmet sets one on API responses; the built client's
  hosting must set its own (Phase 15).
- **No penetration test.** The OWASP pass is a review of code and tests, not an attack on a running
  deployment.
