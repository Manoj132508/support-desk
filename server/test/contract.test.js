import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, call } from './helpers.js';
import { CONTRACT_ROUTES, PUBLIC_ROUTES } from '../src/routes/index.js';
import { AppError, KIND } from '../src/errors/AppError.js';

/**
 * The Phase 6 contract, as assertions.
 *
 * These test the SHAPE of the API rather than its behaviour, because the
 * behaviour is built in Phases 8-11. The shape is what the client already
 * depends on, so it is what can drift today.
 */

test('every route in the contract is mounted', async () => {
  await withServer(async (base) => {
    for (const [method, path] of CONTRACT_ROUTES) {
      const { status } = await call(base, path, { method: method.toUpperCase() });
      // 404 would mean the path is not mounted at all -- a typo in the router
      // or a route the document claims and the code does not have.
      assert.notEqual(status, 404, `${method.toUpperCase()} ${path} is not mounted`);
    }
  });
});

test('an unbuilt route returns a shaped 501 naming its phase', () => {
  // Asserted directly as of Phase 8: every remaining unbuilt route now sits
  // behind `authenticate`, so an unauthenticated call correctly answers 401
  // before it can reach the 501. The end-to-end version of this returns when
  // there is a session to make (Phase 10).
  const error = AppError.notImplemented('Phase 11');
  assert.equal(error.status, 501);
  assert.equal(error.kind, KIND.FAULT);
  assert.match(error.message, /Phase 11/);
});

test('PHASE 8: every non-public route answers 401 without a session', async () => {
  // The access-control design is positional -- everything declared below the
  // `authenticate` line in routes/index.js inherits protection. This asserts
  // the positions rather than trusting a reviewer to eyeball middleware order,
  // and it is what makes "protected by default" a checkable claim.
  const publicSet = new Set(PUBLIC_ROUTES.map(([m, p]) => `${m} ${p}`));

  await withServer(async (base) => {
    for (const [method, path] of CONTRACT_ROUTES) {
      if (publicSet.has(`${method} ${path}`)) continue;

      const { status } = await call(base, path, { method: method.toUpperCase() });
      assert.equal(
        status,
        401,
        `${method.toUpperCase()} ${path} must require a session, got ${status}`,
      );
    }
  });
});

test('the public route list is short and deliberate', () => {
  // Health, so a load balancer can reach it; register and login, because the
  // CSRF cookie they need is set BY them; logout, so a stale cookie can always
  // be cleared. Nothing else -- notably not /api/auth/me, which is the question
  // "who am I?" and therefore needs a session to answer.
  assert.deepEqual(
    PUBLIC_ROUTES.map(([, path]) => path).sort(),
    ['/api/auth/login', '/api/auth/logout', '/api/auth/register', '/api/health'],
  );
});

test('GET /api/auth/me requires a session', async () => {
  await withServer(async (base) => {
    const { status } = await call(base, '/api/auth/me');
    assert.equal(status, 401);
  });
});

test('every error carries the full envelope', async () => {
  await withServer(async (base) => {
    const { body } = await call(base, '/api/nope');
    for (const field of ['kind', 'message', 'customerMessage', 'detail', 'correlationId']) {
      assert.ok(field in body, `envelope is missing ${field}`);
    }
  });
});

test('an unknown /api path answers 401, not 404, so route existence is not enumerable', async () => {
  // A side effect of the Phase 8 middleware order, and a welcome one: an
  // unauthenticated caller cannot map the API surface by probing for 404s.
  await withServer(async (base) => {
    const { status } = await call(base, '/api/definitely-not-a-route');
    assert.equal(status, 401);
  });
});

test('INV-D: 404 bodies are identical regardless of what was asked for', async () => {
  await withServer(async (base) => {
    // Outside /api, so these reach the 404 handler rather than `authenticate`.
    const a = await call(base, '/definitely-not-a-route');
    const b = await call(base, '/another-missing-thing');

    assert.equal(a.status, 404);
    assert.equal(b.status, 404);

    // Everything but the correlation id must match byte for byte. If a 404
    // could vary with what was requested, "another tenant's record" and "no
    // such record" would become distinguishable and INV-D would leak through
    // the error body.
    const strip = ({ correlationId, ...rest }) => rest;
    assert.deepEqual(strip(a.body), strip(b.body));
    assert.equal(a.body.customerMessage, null);
    assert.equal(a.body.detail, null);
  });
});

test('AppError.notFound takes no arguments, so a 404 cannot be made informative', () => {
  const error = AppError.notFound();
  assert.equal(error.status, 404);
  assert.equal(error.customerMessage, null);
  assert.equal(error.detail, null);
  assert.equal(AppError.notFound.length, 0);
});

test('status codes map to kinds as the contract states', () => {
  assert.equal(AppError.malformed('x').status, 422);
  assert.equal(AppError.refused('x').status, 403);
  assert.equal(AppError.stale('x').status, 409);
  assert.equal(AppError.fault('x').status, 500);
});

test('only fault is unexpected — the other three are normal outcomes', () => {
  assert.equal(AppError.malformed('x').expected, true);
  assert.equal(AppError.refused('x').expected, true);
  assert.equal(AppError.stale('x').expected, true);
  assert.equal(AppError.fault('x').expected, false);
});

test('known deliberate states do not log stacks', () => {
  // Found by running the suite: 501s and 404s were logging full stack traces,
  // so a healthy test run produced a wall of alarming errors for a system
  // behaving exactly as designed. A log that cries wolf teaches everyone to
  // stop reading it.
  assert.equal(AppError.notImplemented('Phase 8').expected, true);
  assert.equal(AppError.notFound().expected, true);
});

test('an unknown throw becomes a fault, never a refusal', async () => {
  // Inventing a policy decision that never happened would write a false story
  // into the UI and into anyone's reading of the audit.
  const { errorEnvelope } = await import('../src/middleware/errorEnvelope.js');
  let payload = null;
  const res = {
    status() {
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };
  errorEnvelope(new TypeError('undefined is not a function'), { correlationId: 'c1' }, res, () => {});
  assert.equal(payload.kind, KIND.FAULT);
});

test('ADR 0007: detail is stripped for a customer caller', async () => {
  const { errorEnvelope } = await import('../src/middleware/errorEnvelope.js');
  const error = AppError.refused('Cancellation not permitted after dispatch', {
    customerMessage: 'This order has already shipped.',
    detail: { ruleKey: 'POL-CANCEL-DISPATCHED', ruleVersion: 2 },
  });

  function render(user) {
    let payload = null;
    const res = {
      status() {
        return this;
      },
      json(body) {
        payload = body;
        return this;
      },
    };
    errorEnvelope(error, { correlationId: 'c1', user }, res, () => {});
    return payload;
  }

  const customer = render({ role: 'customer' });
  assert.equal(customer.detail, null, 'a customer must never receive rule detail');
  assert.equal(customer.customerMessage, 'This order has already shipped.');

  const anonymous = render(undefined);
  assert.equal(anonymous.detail, null, 'an unauthenticated caller must never receive rule detail');

  for (const role of ['agent', 'lead', 'admin']) {
    const staff = render({ role });
    assert.deepEqual(staff.detail, { ruleKey: 'POL-CANCEL-DISPATCHED', ruleVersion: 2 });
  }
});
