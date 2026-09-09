import { AppError } from '../errors/AppError.js';

/**
 * Validate and normalise a registration request. A pure function, so the rule
 * that matters most here is testable without a database.
 *
 * THE RULE THAT MATTERS MOST: self-registration can only ever create a
 * `customer`.
 *
 * The obvious implementation takes `role` from the body and defaults it to
 * 'customer'. That is a privilege-escalation hole with a default value in front
 * of it -- anyone who sends `{"role":"admin"}` becomes the person who edits the
 * policy rules that decide what the assistant may do. In a system whose whole
 * claim is that consequential actions are authorised deliberately, letting a
 * stranger self-assign the role that authors those rules would be the single
 * worst bug available.
 *
 * So the role is not read from the body at all. It is a constant. Staff
 * accounts are created by an admin or by the seed script, which is a different
 * code path with a different authorisation.
 */

export const SELF_REGISTRATION_ROLE = 'customer';

/** Deliberately modest. Length beats composition rules -- a 12-character
 *  passphrase resists an offline attack better than "P@ss1!" ever will. */
export const MIN_PASSWORD_LENGTH = 12;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function buildRegistration(body = {}) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const tenantSlug = typeof body.tenantSlug === 'string' ? body.tenantSlug.trim().toLowerCase() : '';

  const problems = [];
  if (!EMAIL_PATTERN.test(email)) problems.push('a valid email is required');
  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!name) problems.push('name is required');
  if (!tenantSlug) problems.push('tenantSlug is required');

  if (problems.length) {
    throw AppError.malformed(`Registration rejected: ${problems.join('; ')}`);
  }

  return {
    email,
    password,
    name,
    tenantSlug,
    // Not `body.role ?? 'customer'`. A constant, so there is no input to get
    // wrong and no default to be talked out of.
    role: SELF_REGISTRATION_ROLE,
  };
}

/** The shape sent to the client. Never the Mongoose document, and never the
 *  hash -- which is also `select: false` at the schema, so this is the second
 *  of two independent reasons it cannot leak. */
export function publicUser(user) {
  return {
    id: String(user._id ?? user.id),
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: String(user.tenantId),
  };
}
