import { composeProblems } from './composeRules.mjs';

/**
 *   docker compose config --format json | node deploy/check-compose.mjs
 *
 * Exits 1 if docker-compose.yml no longer keeps one of its decisions
 * (deploy/composeRules.mjs). CI runs it before building anything.
 */

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const problems = composeProblems(JSON.parse(input));
for (const problem of problems) console.error(`compose: ${problem}`);
if (problems.length > 0) process.exit(1);
console.log('compose: wiring matches the deployment design');
