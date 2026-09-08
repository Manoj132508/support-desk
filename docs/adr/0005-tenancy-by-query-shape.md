# ADR 0005 — Tenancy by query shape; cross-tenant access returns 404, never 403

- **Status:** Accepted
- **Date:** 2026-09-08 (Phase 2)
- **Ported from:** Project 2. Re-affirmed with one project-specific extension.
- **Enforces:** INV-D · **Satisfies:** FR-13.3

## Context

Multiple tenants share the database. The standard mistake is to fetch a record by id, then
check whether it belongs to the caller:

```
const order = await Order.findById(id);          // loaded — already wrong
if (order.tenantId !== user.tenantId) throw 403;  // a check that can be forgotten
```

Two defects. First, the check is *optional* — every new route must remember it, and one that
forgets is a silent cross-tenant read. Second, **403 confirms the record exists.** An attacker
enumerating ids learns which are real from the status code alone. That is an information leak
even when no data is returned.

This project adds a third concern the prior projects did not have: tenancy now guards the
targets of *actions*. A tenancy hole is no longer only a data leak — it is a path to cancelling
someone else's order.

## Decision

**Tenancy is part of the query, not a check after it.**

```
const order = await Order.findOne({ _id: id, tenantId: user.tenantId });
if (!order) throw new NotFound();                 // 404 — indistinguishable
```

- A record in another tenant and a record that does not exist produce **the same response**:
  404. No status code, timing, or message distinguishes them.
- There is no code path that loads a foreign record and then decides what to do with it. The
  record is never in memory.
- Enforced at the data-access layer, not per-route, so a new route cannot forget it. Scoping is
  applied by a Mongoose helper that takes the request context; a query built without one fails
  a lint rule and a test.

**Project-specific extension — tenancy applies to the assistant's tools.** The AI service never
supplies a tenant id; it is derived server-side from the session and injected by Express. A
proposal or tool call naming a target outside the caller's tenant resolves to "no such record",
so it fails as *malformed* at the boundary (ADR 0002) before policy ever sees it. The model
cannot widen its own scope by asking for a different id, because it does not supply the scope.

## Consequences

**Positive**

- Removes the class of bug entirely rather than testing for it route by route.
- No enumeration oracle.
- The action path inherits tenancy for free, including read-only tools.
- Model-supplied identifiers are automatically constrained without special-casing the model.

**Negative**

- Debugging is slightly worse: "404" is less informative than "403" when the cause is a genuine
  configuration mistake. Mitigated by logging the distinction server-side with the correlation
  id, while never exposing it in the response.
- Every query needs the context. Deliberate friction — a query without context is a bug.

**Neutral**

- Admin/lead cross-tenant reporting, if ever needed, is an explicit separate path with its own
  authorisation, not a relaxation of this rule.

## Alternatives considered

**Post-fetch authorisation check (403).** The common approach. Rejected for both defects above:
it is forgettable, and it leaks existence.

**Database-per-tenant.** Strongest isolation. Rejected as disproportionate for a portfolio
project with seeded demo data, and it complicates the audit log, which is inherently
cross-cutting.

**Row-level security in the database.** Not available in the same form in MongoDB, and it would
move the invariant out of testable application code.

## Verified by

- Test: reading another tenant's order returns 404, byte-identical to a nonexistent id.
- Test: a proposal targeting another tenant's order is rejected as malformed at the boundary.
- Test/lint: no business query is constructed without a tenant scope.
