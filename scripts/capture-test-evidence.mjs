// Capture real outputs from the three test runners without using live services.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pythonIndex = process.argv.indexOf('--python');
const python = pythonIndex >= 0 ? process.argv[pythonIndex + 1] : 'python';
if (!python) throw new Error('--python requires an executable');
const revision = spawnSync('git', ['-c', `safe.directory=${root.replace(/[\\/]$/, '')}`, 'rev-parse', 'HEAD'], {
  cwd: root, encoding: 'utf8',
}).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('Cannot establish source revision');
const env = { ...process.env, MONGODB_URI: '', FORCE_COLOR: '0', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1' };
const sanitize = (text) => text.replaceAll(root.replaceAll('\\', '/').replace(/\/$/, ''), '<repo>')
  .replaceAll(root.replace(/[\\/]$/, ''), '<repo>')
  .replace(/\x1b\[[0-9;]*m/g, '');
const cases = [
  { layer: 'Express API', cwd: 'server', executable: process.execPath,
    args: ['--test', '--test-reporter=spec', 'test/*.test.js'], command: 'node --test --test-reporter=spec "test/*.test.js"' },
  { layer: 'React client', cwd: 'client', executable: process.execPath,
    args: ['node_modules/vitest/vitest.mjs', 'run'], command: 'node node_modules/vitest/vitest.mjs run' },
  { layer: 'FastAPI AI service', cwd: 'ai-service', executable: python,
    args: ['-B', '-m', 'pytest', '-q', '-p', 'no:cacheprovider'], command: 'python -B -m pytest -q -p no:cacheprovider' },
];
let log = `AI Support Desk - local test evidence\nSource revision: ${revision}\nCaptured: ${new Date().toISOString()}\nNode: ${process.version}\nPlatform: ${process.platform} ${process.arch}\nScope: offline/model-free tests; MONGODB_URI unset; no live application database or model used.\n\n`;
let failed = false;
for (const test of cases) {
  const start = performance.now();
  const result = spawnSync(test.executable, test.args, {
    cwd: path.join(root, test.cwd), env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
  const seconds = ((performance.now() - start) / 1000).toFixed(2);
  log += `=== ${test.layer} ===\nWorking directory: ${test.cwd}\nCommand: ${test.command}\n`;
  log += sanitize(result.stdout || '') + sanitize(result.stderr || '');
  if (result.error) log += `${result.error.message}\n`;
  log += `\nExit code: ${result.status}\nElapsed seconds: ${seconds}\n\n`;
  console.log(`${test.layer}: exit=${result.status}; elapsed=${seconds}s`);
  if (result.status !== 0) failed = true;
}
mkdirSync(path.join(root, 'docs/evidence'), { recursive: true });
writeFileSync(path.join(root, 'docs/evidence/local-tests.txt'), log, 'utf8');
console.log('Saved complete runner output to docs/evidence/local-tests.txt');
process.exitCode = failed ? 1 : 0;
