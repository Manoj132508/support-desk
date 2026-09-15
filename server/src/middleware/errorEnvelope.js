import { AppError, KIND } from '../errors/AppError.js';

/**
 * The last middleware. Every non-2xx response in the system is shaped here.
 *
 * Two responsibilities, and the second is a safety property rather than
 * tidiness.
 *
 * 1. ONE SHAPE. `{ kind, message, customerMessage, detail, escalated,
 *    correlationId }`, always, so the client's `api.js` never has to guess. An
 *    unknown throw becomes a `fault` -- never a `refused`, because inventing a
 *    policy decision that never happened would write a false story into the UI
 *    and into anyone's reading of the audit.
 *
 * 2. `detail` IS STRIPPED FOR CUSTOMER CALLERS. ADR 0007 separates the two
 *    channels at the data layer; this separates them at the transport layer.
 *    Doing it here rather than in each route means a route CANNOT leak a rule
 *    id by forgetting -- there is one place to get it right, and it is tested.
 *
 * `escalated` was added in Phase 11 (ADR 0010): whether a colleague is already
 * coming. It is false unless the error says otherwise.
 */

function isStaff(req) {
  const role = req.user?.role;
  return role === 'agent' || role === 'lead' || role === 'admin';
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
export function errorEnvelope(err, req, res, next) {
  const appError =
    err instanceof AppError
      ? err
      : AppError.fault(err?.message ?? 'Unexpected error');

  // A 404 must be byte-identical whether the record is absent or another
  // tenant's (INV-D). Re-deriving it here means even a hand-built 404 from a
  // route cannot accidentally carry a message.
  if (appError.status === 404) {
    return res.status(404).json({
      kind: KIND.FAULT,
      message: 'Not found',
      customerMessage: null,
      detail: null,
      escalated: false,
      correlationId: req.correlationId ?? null,
    });
  }

  if (!appError.expected) {
    // Faults are bugs. Log the stack; the other three kinds are ordinary
    // outcomes and logging stacks for them trains everyone to ignore the log.
    console.error(
      JSON.stringify({
        level: 'error',
        correlationId: req.correlationId,
        method: req.method,
        path: req.originalUrl,
        message: appError.message,
        stack: err?.stack,
      }),
    );
  }

  res.status(appError.status).json({
    kind: appError.kind,
    // An UNEXPECTED error's message is for the log above, never for the caller
    // (OWASP A05). It can carry whatever the failure happened to include -- a
    // driver error quoting the value that broke a unique index, a cast error
    // naming a model, a hostname -- and nothing in it helps the caller. Expected
    // errors keep theirs: those messages were written to be read.
    message: appError.expected ? appError.message : 'Something went wrong',
    customerMessage: appError.customerMessage,
    detail: isStaff(req) ? appError.detail : null,
    escalated: appError.escalated === true,
    correlationId: req.correlationId ?? null,
  });
}

/** Anything that reached the end of the router does not exist. */
export function notFoundHandler(req, res, next) {
  next(AppError.notFound());
}
