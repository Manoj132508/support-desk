import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationFor } from './support/githubAnnotations.mjs';

/** Phase 15: the reporter that makes a CI failure readable without signing in. */

test('a failed test becomes an annotation with its file, line, name and message', () => {
  const previous = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = '/home/runner/work/support-desk/support-desk';
  try {
    const line = annotationFor({
      name: 'health: a hung AI service, cannot hang',
      file: '/home/runner/work/support-desk/support-desk/server/test/health.test.js',
      line: 21,
      details: { error: { failureType: 'testCodeFailure', cause: new Error('pending\nwhen the loop ended: 100%') } },
    });
    assert.equal(
      line,
      '::error file=server/test/health.test.js,line=21,title=health%3A a hung AI service%2C cannot hang::pending%0Awhen the loop ended: 100%25\n',
    );
  } finally {
    if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previous;
  }
});

test('a suite that failed only because a test inside it did is not annotated twice', () => {
  assert.equal(annotationFor({ name: 'suite', details: { error: { failureType: 'subtestsFailed' } } }), null);
});

test('a failure with no file still produces an annotation', () => {
  assert.equal(annotationFor({ name: 'x', details: { error: new Error('boom') } }), '::error title=x::boom\n');
});
