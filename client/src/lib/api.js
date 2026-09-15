import { ERROR_KIND } from './outcomes.js';

/**
 * The single place the client talks to the API.
 *
 * Three responsibilities, and the third is the interesting one.
 *
 * 1. CREDENTIALS. `credentials: 'include'` sends the httpOnly session cookie.
 *    The client never sees or stores a token -- that is the point of httpOnly,
 *    and it is why XSS cannot exfiltrate a session here.
 *
 * 2. CSRF. Because the session travels in a cookie, the browser attaches it to
 *    cross-site requests too, so a cookie alone is not proof of intent. The
 *    server sets a SECOND, non-httpOnly cookie that JavaScript can read; we
 *    echo it in a header. An attacker's page can cause a request but cannot
 *    read our cookie to set the header, so the echo is the proof. This is the
 *    double-submit pattern, ported from Project 2.
 *
 * 3. THE ERROR TAXONOMY. Every failed response is normalised into an ApiError
 *    carrying one of the four kinds from Phase 2 section 5. This is where a
 *    refusal stops being "a 4xx" and becomes a first-class outcome the UI can
 *    render in the policy language rather than the fault language.
 */

export class ApiError extends Error {
  constructor({ kind, message, customerMessage, detail, status, escalated }) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    /** Plain, rule-authored text safe to show a customer (ADR 0007). */
    this.customerMessage = customerMessage ?? null;
    /** Rule key, version, matched conditions. Internal surfaces only. */
    this.detail = detail ?? null;
    this.status = status ?? null;
    /**
     * Whether a colleague has already been brought in (ADR 0010). Only the
     * server's literal `true` counts: the screen must never tell a customer a
     * colleague is coming on a guess.
     */
    this.escalated = escalated === true;
  }
}

/**
 * These two names are a CONTRACT WITH THE SERVER, which sets the cookie in
 * `server/src/auth/cookies.js`. They are constants here rather than inline
 * strings because a mismatch does not fail loudly — the header is simply
 * absent, and every write fails CSRF for a reason that looks nothing like a
 * naming problem. (It happened: the client read `csrfToken` while the server
 * set `asd_csrf`.)
 */
export const CSRF_COOKIE = 'asd_csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

function readCookie(name) {
  const match = document.cookie.match(
    new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

export function csrfHeaders() {
  const token = readCookie(CSRF_COOKIE);
  return token ? { [CSRF_HEADER]: token } : {};
}

/**
 * Map a failed response onto the taxonomy.
 *
 * The server is expected to send `{ kind, message, customerMessage, detail,
 * escalated }`. The status-code fallbacks exist so that an unexpected failure --
 * a proxy error page, a crash before the error middleware runs -- still lands
 * somewhere sane instead of rendering `undefined` at the user.
 *
 * Note the default is FAULT, not REFUSED. Guessing "refused" would invent a
 * policy decision that never happened and write a false story into the UI.
 * If we do not know, we say something broke.
 */
async function toApiError(response) {
  let body = {};
  try {
    body = await response.json();
  } catch {
    // Non-JSON error body (proxy page, gateway timeout). Fall through.
  }

  const kind =
    body.kind ??
    (response.status === 409
      ? ERROR_KIND.STALE
      : response.status === 422
        ? ERROR_KIND.MALFORMED
        : ERROR_KIND.FAULT);

  return new ApiError({
    kind,
    message: body.message ?? `Request failed (${response.status})`,
    customerMessage: body.customerMessage,
    detail: body.detail,
    status: response.status,
    escalated: body.escalated,
  });
}

export async function apiFetch(path, options = {}) {
  const method = options.method ?? 'GET';
  const isWrite = method !== 'GET' && method !== 'HEAD';

  const response = await fetch(path, {
    ...options,
    method,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(isWrite ? csrfHeaders() : {}),
      ...options.headers,
    },
  });

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return null;
  return response.json();
}

export const api = {
  get: (path) => apiFetch(path),
  post: (path, body) =>
    apiFetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: (path, body) =>
    apiFetch(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
};
