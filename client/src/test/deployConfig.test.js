import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Phase 15: the nginx configuration the client is served with.
 *
 * nginx cannot run here, and its header inheritance fails silently in both
 * directions: a location with its own add_header loses the server's headers,
 * and a location without one gains them all. So the rules are checked on the
 * text, and the headers themselves by the compose smoke test in CI.
 */

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const nginx = read('../../deploy/nginx.conf');
const headers = read('../../deploy/security-headers.conf');
const INCLUDE = 'include /etc/nginx/snippets/security-headers.conf;';

const withoutComments = (text) => text.replace(/#.*$/gm, '');

/** Each `location ... { ... }` block. The file has no nested blocks. */
function locations(text) {
  return [...withoutComments(text).matchAll(/location\s+([^{]+)\{([^}]*)\}/g)].map(([, match, body]) => ({
    match: match.trim(),
    body,
  }));
}

function csp() {
  const directive = withoutComments(headers).match(/add_header Content-Security-Policy "([^"]+)" always;/);
  return Object.fromEntries(
    directive[1].split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe('nginx security headers', () => {
  it('every location that serves the app includes the security headers', () => {
    const app = locations(nginx).filter((location) => location.match !== '/api/' && !location.match.startsWith('~'));
    expect(app.map((location) => location.match).sort()).toEqual(['/', '/assets/', '= /index.html']);
    for (const location of app) expect(location.body, location.match).toContain(INCLUDE);
  });

  it('the headers are never set for the whole server, where /api/ would inherit them twice over helmet', () => {
    const outsideLocations = withoutComments(nginx).replace(/location\s+[^{]+\{[^}]*\}/g, '');
    expect(outsideLocations).not.toContain('security-headers.conf');
    expect(outsideLocations).not.toContain('add_header');
    const api = locations(nginx).find((location) => location.match === '/api/');
    expect(api.body).not.toContain('add_header');
    expect(api.body).not.toContain('security-headers');
  });

  it('every header is sent with `always`, so error pages carry them too', () => {
    const lines = withoutComments(headers).split('\n').filter((line) => line.trim().startsWith('add_header'));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) expect(line.trim().endsWith('always;'), line).toBe(true);
  });

  it('the content security policy allows nothing inline, nothing evaluated, and no other origin', () => {
    const policy = csp();
    const everything = Object.values(policy).flat();
    expect(everything).not.toContain("'unsafe-inline'");
    expect(everything).not.toContain("'unsafe-eval'");
    expect(everything.filter((source) => /^https?:|^\*$/.test(source))).toEqual([]);
    expect(policy['default-src']).toEqual(["'self'"]);
    expect(policy['script-src']).toEqual(["'self'"]);
    expect(policy['object-src']).toEqual(["'none'"]);
    // ADR 0009: the confirmation dialog must not be framed by another site.
    expect(policy['frame-ancestors']).toEqual(["'none'"]);
  });
});

describe('nginx API proxy', () => {
  const api = () => locations(nginx).find((location) => location.match === '/api/').body;

  it('streams turns rather than buffering them', () => {
    expect(api()).toMatch(/proxy_buffering off;/);
    expect(api()).toMatch(/proxy_cache off;/);
  });

  it('appends the address it saw, which is the one hop the API trusts', () => {
    expect(api()).toMatch(/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  });

  it('proxies to the API service on its port', () => {
    expect(api()).toMatch(/proxy_pass http:\/\/api:4400;/);
  });
});
