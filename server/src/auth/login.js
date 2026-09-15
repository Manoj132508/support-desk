/**
 * Checking a sign-in, with its lookups injected, so the rule that matters is
 * testable without a database.
 *
 * THE RULE THAT MATTERS: the user is found within a TENANT.
 *
 * Emails are unique per tenant -- the `(tenantId, email)` index, Phase 3 -- so
 * one address can hold an account in two tenants. Login used to look the user
 * up by email alone and take whichever the database returned first. The other
 * account could never sign in, and if both passwords matched, which tenant you
 * landed in was chance. Every other query in the system carries its tenant by
 * construction (ADR 0005); this one, the only lookup made before anyone is
 * signed in, did not. Found in Phase 12.
 */

const text = (value) => (typeof value === 'string' ? value : '');

/** Only strings are read. An object in the body -- `{ "$ne": null }` -- is
 *  treated as empty, never passed on to a query. */
export function readCredentials(body = {}) {
  return {
    email: text(body?.email).trim().toLowerCase(),
    password: text(body?.password),
    tenantSlug: text(body?.tenantSlug).trim().toLowerCase(),
  };
}

/**
 * Returns the user, or null for every kind of failure alike: unknown
 * organisation, unknown email, wrong password, disabled account.
 */
export async function checkCredentials(body, { findTenantBySlug, findUserForLogin, verifyPassword }) {
  const { email, password, tenantSlug } = readCredentials(body);

  const tenant = email && tenantSlug ? await findTenantBySlug(tenantSlug) : null;
  const user = tenant ? await findUserForLogin(tenant._id, email) : null;

  // A full comparison whether or not an account was found, so a missing
  // organisation or address costs the same bcrypt time as a wrong password.
  const ok = await verifyPassword(password, user?.passwordHash);

  return ok && user && user.status === 'active' ? user : null;
}
