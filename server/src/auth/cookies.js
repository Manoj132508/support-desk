import { randomBytes } from 'node:crypto';
import { config } from '../config/env.js';

export const SESSION_COOKIE = 'asd_session';
export const CSRF_COOKIE = 'asd_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Cookie attributes, defined once. Ported from Project 2.
 *
 * THE BUG THIS PREVENTS: `res.clearCookie(name)` does not delete by name -- it
 * sets an empty value with a past expiry, and the browser treats that as the
 * SAME cookie only if path, domain, secure and sameSite all match. Clear with
 * different options and the user clicks "sign out", gets a success response,
 * and stays signed in. Deriving set and clear from one function makes the
 * mismatch impossible rather than merely unlikely.
 */
function baseCookieOptions() {
  return {
    httpOnly: true, // not readable by JS, so XSS cannot exfiltrate the session
    secure: config.isProduction, // HTTPS only in prod; false in dev or the cookie is dropped on http
    sameSite: 'strict', // not attached cross-site: the first CSRF defence
    path: '/',
  };
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, { ...baseCookieOptions(), maxAge: config.jwtExpiresMs });
}

/**
 * The CSRF half of the double-submit pair. Deliberately NOT httpOnly -- the
 * client must read it to echo it in a header.
 *
 * Safe, because the token is not a credential: knowing it grants nothing. Its
 * only job is to prove the request came from a page that could read our cookie,
 * which the same-origin policy denies to an attacker's site.
 */
export function setCsrfCookie(res) {
  const token = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE, token, {
    ...baseCookieOptions(),
    httpOnly: false,
    maxAge: config.jwtExpiresMs,
  });
  return token;
}

/** Clears both cookies with attributes matching those they were set with. */
export function clearAuthCookies(res) {
  const options = baseCookieOptions();
  res.clearCookie(SESSION_COOKIE, options);
  res.clearCookie(CSRF_COOKIE, { ...options, httpOnly: false });
}

/** Exported so a test can assert the attributes rather than trusting them. */
export { baseCookieOptions };
