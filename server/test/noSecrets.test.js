import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * NFR-3: "no secrets in the repo", as a check that runs on every push rather
 * than a sentence someone once meant.
 *
 * It scans the working tree, which in CI is exactly what was committed. A
 * developer's own `.env` is skipped, because it is gitignored and is where
 * secrets are supposed to live. The patterns are built from pieces so this
 * file cannot match itself.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  'dist',
  'build',
  'coverage',
  'index',
]);
const TEXT_EXTENSIONS = new Set(['', '.js', '.jsx', '.mjs', '.cjs', '.json', '.py', '.md', '.yml', '.yaml', '.toml', '.txt', '.css', '.html', '.ini', '.cfg', '.conf', '.example']);

const PATTERNS = [
  ['a private key', new RegExp('-----BEGIN [A-Z ]*PRIVATE ' + 'KEY-----')],
  ['a database URI with a password in it', new RegExp('mongodb(?:\\+srv)?:\\/\\/[^\\s:/@\'"`]+:[^\\s@/\'"`]+' + '@')],
  ['an AWS access key', new RegExp('AKIA' + '[0-9A-Z]{16}')],
  ['an API key in the sk- format', new RegExp('\\bsk-' + '[A-Za-z0-9_-]{32,}')],
  ['a GitHub token', new RegExp('\\bgh[pousr]_' + '[A-Za-z0-9]{36}')],
];

/** In an env-style file, a secret setting must be empty. */
const ENV_SECRET = /^(?:JWT_SECRET|AI_SERVICE_TOKEN|MONGODB_URI)=\S+/m;

// Committed examples end in `.example` and ARE scanned. The first version of
// this rule named `.env.example` alone, so `.env.compose.example` (Phase 15)
// would have been skipped as somebody's private file.
const isLocalEnvFile = (name) => name === '.env' || (name.startsWith('.env.') && !name.endsWith('.example'));

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) yield* files(path);
    } else if (!isLocalEnvFile(entry.name) && TEXT_EXTENSIONS.has(extname(entry.name)) && path !== THIS_FILE) {
      yield path;
    }
  }
}

test('NFR-3: nothing in the repository looks like a secret', () => {
  const found = [];
  let scanned = 0;
  for (const path of files(ROOT)) {
    scanned += 1;
    const text = readFileSync(path, 'utf8');
    for (const [label, pattern] of PATTERNS) {
      if (pattern.test(text)) found.push(`${relative(ROOT, path)}: ${label}`);
    }
    if (basename(path).includes('.env') && ENV_SECRET.test(text)) {
      found.push(`${relative(ROOT, path)}: a secret setting with a value`);
    }
  }
  assert.ok(scanned > 100, `only ${scanned} files scanned -- the walk is broken, not the repo clean`);
  assert.deepEqual(found, []);
});

test('the scan would catch what it is meant to catch', () => {
  const samples = {
    'a private key': '-----BEGIN RSA PRIVATE ' + 'KEY-----',
    'a database URI with a password in it': 'mongodb+srv://desk:hunter2' + '@cluster0.example.net/db',
    'an AWS access key': 'AKIA' + 'ABCDEFGHIJKLMNOP',
  };
  for (const [label, sample] of Object.entries(samples)) {
    const pattern = PATTERNS.find(([name]) => name === label)[1];
    assert.ok(pattern.test(sample), label);
  }
  assert.ok(ENV_SECRET.test('JWT_SECRET=something'));
  assert.equal(ENV_SECRET.test('#   MONGODB_URI=mongodb://127.0.0.1:27017/desk'), false);
  assert.equal(ENV_SECRET.test('JWT_SECRET='), false);
});

test('.env files are ignored by git, and the examples are not', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('.env'));
  assert.ok(ignore.includes('.env.*'));
  assert.ok(ignore.includes('!.env.example'));
  assert.ok(ignore.includes('!.env.compose.example'));
});

test('both committed env examples, and the deployment files, are among what is scanned', () => {
  const scanned = new Set([...files(ROOT)].map((path) => relative(ROOT, path).replace(/\\/g, '/')));
  for (const expected of ['.env.example', '.env.compose.example', 'docker-compose.yml', 'server/Dockerfile', 'client/deploy/nginx.conf']) {
    assert.ok(scanned.has(expected), `${expected} is not scanned`);
  }
  assert.equal(isLocalEnvFile('.env.production'), true);
  assert.equal(isLocalEnvFile('.env.compose.example'), false);
});
