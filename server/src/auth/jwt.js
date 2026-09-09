import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

/**
 * Session tokens. Ported from Project 2, with one project-specific note below.
 *
 * The payload carries the user id and NOTHING ELSE. Every extra claim is a copy
 * of data that can go stale: a token minted before an email change would carry
 * the old address for its whole lifetime. The id is the one fact that never
 * changes; everything else is loaded fresh on each request.
 *
 * THAT MATTERS MORE HERE THAN IT DID IN PROJECT 2. If `role` or `tenantId`
 * lived in the token, then demoting an admin, disabling an account, or moving
 * a user between tenants would not take effect until the token expired -- and
 * in a system where role decides who may authorise a consequential action, a
 * stale role is a stale authorisation. Loading them fresh means a revocation is
 * immediate.
 *
 * What a JWT does not give us is revocation of the token itself. A stolen token
 * is valid until it expires. That is the trade -- statelessness for
 * revocability -- and why the lifetime is short and the cookie is httpOnly.
 */
const ISSUER = 'asd'; // ai-support-desk

export function signSessionToken(userId) {
  if (!config.jwtSecret) {
    // Never fall back to a development secret. A signing key with a default is
    // a signing key that reaches production.
    throw new Error('JWT_SECRET is not configured');
  }
  return jwt.sign({ sub: String(userId) }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    issuer: ISSUER,
  });
}

/**
 * Returns null on ANY failure -- bad signature, expired, malformed, wrong
 * issuer -- because the caller must not distinguish them. "Expired" versus
 * "invalid signature" tells an attacker which half of their forgery was wrong.
 *
 * `issuer` is verified too, so a token signed with the same secret by another
 * service in the estate is not accepted here.
 */
export function verifySessionToken(token) {
  if (!config.jwtSecret) return null;
  try {
    return jwt.verify(token, config.jwtSecret, { issuer: ISSUER });
  } catch {
    return null;
  }
}
