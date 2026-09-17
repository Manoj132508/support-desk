import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A node:test reporter that turns each failed test into a GitHub annotation.
 * Phase 15.
 *
 * GitHub shows a job's log only to people signed in, but annotations are
 * readable by anyone, through the API as well. When CI first failed on this
 * repository the log said which test and why, and nobody without a session
 * could read it. `npm run test:ci` runs this beside the usual spec reporter, so
 * a failure's test name, file, line and message reach the annotations.
 *
 * Workflow command syntax: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 */

const escapeData = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (value) => escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');

function repositoryPath(file) {
  if (!file) return null;
  const path = file.startsWith('file:') ? fileURLToPath(file) : file;
  return relative(process.env.GITHUB_WORKSPACE ?? process.cwd(), path).replace(/\\/g, '/');
}

export function annotationFor({ name, details, file, line }) {
  const error = details?.error;
  // A suite or file whose tests failed reports that too; the failing test
  // already has its own annotation with the real message.
  if (error?.failureType === 'subtestsFailed') return null;
  const cause = error?.cause ?? error;
  const message = cause?.message ?? String(cause ?? 'failed');
  const path = repositoryPath(file);
  const location = path ? `file=${escapeProperty(path)},line=${line ?? 1},` : '';
  return `::error ${location}title=${escapeProperty(name)}::${escapeData(message)}\n`;
}

export default async function* githubAnnotations(source) {
  for await (const event of source) {
    if (event.type !== 'test:fail') continue;
    const annotation = annotationFor(event.data);
    if (annotation) yield annotation;
  }
}
