import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as vocabulary from '../src/policy/vocabulary.js';
import * as models from '../src/db/models/index.js';

/**
 * One vocabulary, two consumers.
 *
 * The engine needs the ladder and the condition registry; so does the schema
 * that validates rules on save. If they held separate copies, a field added to
 * one and not the other would produce rules the schema accepts and the engine
 * fails closed on -- a permanent silent escalation. These tests assert there is
 * exactly one copy.
 */

test('the schema re-exports the very same objects, not equal copies', () => {
  // strictEqual, not deepEqual: identity is the claim.
  assert.strictEqual(models.OUTCOME_LADDER, vocabulary.OUTCOME_LADDER);
  assert.strictEqual(models.CONDITION_FIELDS, vocabulary.CONDITION_FIELDS);
});

test('the PolicyRule schema enforces the same ladder the engine uses', () => {
  assert.deepEqual(models.PolicyRule.schema.path('outcome').enumValues, [...vocabulary.OUTCOME_LADDER]);
});

test('the vocabulary imports nothing, so the engine inherits no dependencies through it', () => {
  const code = readFileSync(fileURLToPath(new URL('../src/policy/vocabulary.js', import.meta.url)), 'utf8');
  assert.ok(!/^\s*import\s/m.test(code), 'vocabulary.js must have no imports');
});

test('the vocabulary is deeply frozen', () => {
  assert.throws(() => {
    vocabulary.OUTCOME_LADDER.push('yolo');
  }, TypeError);
  assert.throws(() => {
    vocabulary.CONDITION_FIELDS['order.status'].operators.push('lt');
  }, TypeError);
});

test('deny by default resolves to agent-only, which is on the ladder', () => {
  assert.equal(vocabulary.DEFAULT_OUTCOME, 'agent-only');
  assert.ok(vocabulary.OUTCOME_LADDER.includes(vocabulary.DEFAULT_OUTCOME));
});
