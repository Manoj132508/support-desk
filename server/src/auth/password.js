import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';

/**
 * Password hashing. Ported from Project 2.
 *
 * bcrypt rather than a plain hash, because the property that matters is being
 * SLOW. A fast hash is a fast offline attack: an attacker with the dump tries
 * billions of candidates a second. bcrypt's cost factor makes each attempt
 * expensive, and the factor is raisable later without invalidating existing
 * hashes -- the cost is stored inside the hash string itself.
 *
 * The salt is generated per password and embedded in the output, so two users
 * with the same password get different hashes and a precomputed rainbow table
 * is worthless.
 */

/** OWASP's current floor is 10; 12 is the common recommendation. */
export const MINIMUM_ROUNDS = 12;

export function hashPassword(plain, rounds = config.bcryptRounds) {
  return bcrypt.hash(plain, rounds);
}

/**
 * Always runs a full comparison, even against a null hash.
 *
 * A short-circuit `if (!hash) return false` returns in microseconds, while a
 * real comparison takes ~250ms. That difference is measurable over the network
 * and turns login into an account-enumeration oracle: an attacker learns which
 * emails exist by timing the response alone. So a missing hash is compared
 * against a dummy of the same shape, and the two paths cost the same.
 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.iBrTMKXbCFTLIvJtOKPwj4EI7d5ZLhq';

export async function verifyPassword(plain, hash) {
  const target = hash || DUMMY_HASH;
  const matched = await bcrypt.compare(plain ?? '', target);
  // If there was no hash, the comparison was theatre. Its RESULT is discarded;
  // its COST is the point.
  return hash ? matched : false;
}
