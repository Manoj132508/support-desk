# Phase 8 — Authentication

**Project 3 · AI Support Desk**
Status: complete. Ported from Project 2, with four project-specific changes. **97 server tests**
(up from 63), **136 across the project**, all green.

---

## 1. What exists now

```
server/src/
  auth/
    password.js        bcrypt, with a constant-time miss
    jwt.js             session tokens — id only, nothing else
    cookies.js         httpOnly session + readable CSRF, attributes defined once
    registration.js    pure validation; the role is a constant
  middleware/
    authenticate.js    the security boundary; user loader is injectable
    requireRole.js     four roles, two convenience sets
    csrf.js            double-submit verification
  routes/auth.js       register · login · logout · me
```

Everything except `routes/auth.js` is tested without a database — `authenticate` takes an
injectable user loader for exactly that reason. The thing that decides *who you are* should be
exhaustively testable, which is the same argument that made the policy engine pure (NFR-6).

---

## 2. Genuinely ported from Project 2

Project 2's server was open on disk. These came across with their reasoning intact:

| Ported | The reasoning that came with it |
|---|---|
| `cookies.js` | `clearCookie` only clears when path/domain/secure/sameSite **match** — deriving set and clear from one function makes the "logged out but still logged in" bug impossible |
| `jwt.js` | Payload carries the id and nothing else; verify returns `null` on *any* failure so "expired" and "bad signature" are indistinguishable |
| `csrf.js` | Double-submit; length check before `timingSafeEqual`, which throws on mismatch |
| `authenticate` | The database lookup after signature verification is **not** redundant |

---

## 3. Four things that are different here

### 3.1 Self-registration can only ever create a customer

The obvious implementation reads `role` from the body and defaults it to `'customer'`. That is
a privilege-escalation hole with a default value in front of it.

In this system it would be the single worst bug available: an attacker sending
`{"role":"admin"}` becomes the person who **edits the policy rules that decide what the
assistant may do**. A project whose entire claim is that consequential actions are authorised
deliberately cannot let a stranger self-assign the role that authors those authorisations.

So the role is not read from the body at all. It is a constant:

```js
role: SELF_REGISTRATION_ROLE,   // not body.role ?? 'customer'
```

No input to get wrong, no default to be talked out of. Staff accounts come from an admin or the
seed script — a different code path with a different authorisation. Tested against `'admin'`,
`'lead'`, `'agent'`, `'ADMIN'`, an array, and an object.

### 3.2 Role and tenant are loaded fresh, and here that is a safety property

Project 2's reason for keeping claims out of the token was staleness — a token minted before an
email change carries the old address.

Here it is stronger. **`role` decides who may authorise a consequential action, so a stale role
is a stale authorisation.** If role lived in the token, demoting an admin would not take effect
until their token expired — up to twelve hours of someone editing policy rules they are no
longer entitled to touch. The database lookup costs one indexed find per request and buys
immediate revocation.

The same applies to `tenantId`, and more sharply: it is set in `authenticate` from the loaded
user and **nowhere else**. Never from a body, a query string, or a header. That is what makes
ADR 0005's promise real — `scoped()` demands a tenant context, and the only thing that can
supply one is the session.

### 3.3 `authenticate` runs before `requireCsrfToken`

The order was chosen, not inherited.

CSRF exists to prove that a request *from an authenticated browser* was genuine, so it is only
meaningful once there **is** a session. Putting it first answers a signed-out user with `403`
("forbidden") when the true answer is `401` ("sign in"). Misleading a legitimate client to save
a database lookup on forged requests is the wrong trade.

A welcome side effect: an unknown `/api` path now answers `401` rather than `404`, so an
unauthenticated caller cannot map the API surface by probing for missing routes.

### 3.4 Access control is positional, and therefore default-on

```js
apiRouter.use(healthRouter);        // public
apiRouter.use('/auth', authRouter); // public — see below
apiRouter.use(authenticate);        // ── the line ──
apiRouter.use(requireCsrfToken);
// everything declared below inherits both
```

A new protected route is protected **by default**. Forgetting is not an available mistake: a
developer would have to deliberately mount above the line to create an unprotected route.

`PUBLIC_ROUTES` is exported and a test asserts every other route in the contract answers `401`
without a session — so the claim is checked rather than eyeballed in middleware order.

Auth sits above the line because **register and login cannot carry a CSRF token — the cookie
that would supply it is set *by* those requests.** The residual exposure is "login CSRF", where
an attacker signs a victim into the attacker's account; `SameSite=Strict` is the defence there,
and it is a materially smaller problem than being unable to log in. Logout is exempt
deliberately: someone holding a stale cookie still needs a way to clear it.

---

## 4. Two details worth an interview answer

**A failed login costs the same whether the account exists or not.** `verifyPassword` compares
against a dummy hash when there is no user, so a miss and a wrong password both take a full
bcrypt round. A short-circuit `if (!hash) return false` returns in microseconds against ~250ms —
measurable over the network, and enough to enumerate which email addresses hold accounts. There
is a test asserting the miss does real work.

Registration applies the same logic at a different layer: an unknown tenant, an
already-registered email and a malformed address all return the **same** `422`. Otherwise
registration becomes an oracle for which organisations use the product and which addresses have
accounts.

**`passwordHash` is `select: false`.** The default is the protection — without it, every
`findOne` in the system carries a hash it does not need, and one careless `res.json(user)` puts
it on the wire. Login opts in explicitly with `.select('+passwordHash')`; nothing else does.
`publicUser()` is the second, independent guard.

---

## 5. An integration bug caught by wiring the two halves together

The client read a CSRF cookie named `csrfToken`. The server sets `asd_csrf`.

This would not have failed loudly. The header would simply be absent, and **every write in the
application would fail CSRF** — for a reason that looks nothing like a naming problem, and only
at the first login attempt against a real server.

Both names are now exported constants with a comment naming them as a cross-repo contract. It is
the kind of defect that only appears when the halves meet, which is an argument for building
the API contract (Phase 6) before either side assumes anything.

---

## 6. Honestly unverified

`register` and `login` are written but **not exercised end to end**, because they need a
database. Registration in particular uses a **transaction** — a `User` with a dangling
`customerId` is an account that can sign in and own nothing — so it needs the replica set from
Phase 7.

Unverified until `MONGODB_URI` is set:

- Register → login → `/me` as a round trip.
- The unique `(tenantId, email)` index rejecting a duplicate registration.
- The registration transaction rolling back both documents on failure.
- Cookies surviving a real browser round trip through the Vite proxy.

Everything in §2–§4 is covered by the 34 new tests and needs no database.

---

*Phase 9 builds KB ingestion and the FastAPI AI service: retrieval ported from Project 1,
grounded answers with citations (INV-C), and the SSE streaming path — the first phase where the
model appears at all, and where the trust boundary from ADR 0002 becomes real code.*
