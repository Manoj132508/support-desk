import test from 'node:test';
import assert from 'node:assert/strict';
import { errorEnvelope } from '../src/middleware/errorEnvelope.js';
import { AppError } from '../src/errors/AppError.js';

/**
 * ADR 0010 at the transport layer: an error tells the customer's screen whether
 * a colleague is already coming.
 */

function render(error, user = { role: 'customer' }) {
  let status = null;
  let payload = null;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };
  errorEnvelope(error, { correlationId: 'c1', user }, res, () => {});
  return { status, payload };
}

test('ADR 0010: a refusal at execution that escalated says so', () => {
  const { status, payload } = render(
    AppError.stale('Refused at execution', { customerMessage: 'This order has now been dispatched.', escalated: true }),
  );
  assert.equal(status, 409);
  assert.equal(payload.escalated, true);
});

test('escalated is false unless the error says otherwise — never inferred from its kind', () => {
  const errors = [AppError.stale('x'), AppError.refused('x'), AppError.malformed('x'), new Error('not an AppError')];
  for (const error of errors) {
    assert.equal(render(error).payload.escalated, false, error.message);
  }
});

test('only a literal true counts as a promise to the customer', () => {
  assert.equal(new AppError('stale', { escalated: 'yes' }).escalated, false);
  assert.equal(new AppError('stale', { escalated: 1 }).escalated, false);
  assert.equal(new AppError('stale', { escalated: true }).escalated, true);
});

test('INV-D: a 404 is still byte-identical, with escalated among its fixed fields', () => {
  assert.deepEqual(render(AppError.notFound()).payload, {
    kind: 'fault',
    message: 'Not found',
    customerMessage: null,
    detail: null,
    escalated: false,
    correlationId: 'c1',
  });
});
