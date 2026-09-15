import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext.jsx';
import LoginPage from '../routes/LoginPage.jsx';
import { safeRedirect } from '../lib/safeRedirect.js';

/**
 * Signing in (Phase 12): the organisation is part of the credentials, and where
 * the page goes afterwards cannot be chosen by someone else's link.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function stubApi({ loginStatus = 200 } = {}) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path, init = {}) => {
      calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
      if (path === '/api/auth/me') {
        return new Response(JSON.stringify({ kind: 'fault', message: 'Authentication required' }), { status: 401, headers: JSON_HEADERS });
      }
      if (path === '/api/auth/login') {
        return loginStatus === 200
          ? new Response(JSON.stringify({ user: { id: 'u1', role: 'customer', email: 'ana@acme.test', tenantId: 't1' } }), { status: 200, headers: JSON_HEADERS })
          : new Response(JSON.stringify({ kind: 'fault', message: 'Invalid email or password' }), { status: loginStatus, headers: JSON_HEADERS });
      }
      throw new Error(`Unexpected request ${path}`);
    }),
  );
  return calls;
}

function renderLogin(from) {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/login', state: from === undefined ? undefined : { from } }]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>Home page</p>} />
          <Route path="/console" element={<p>Console page</p>} />
          <Route path="*" element={<p>Somewhere else</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function signIn(user) {
  await user.type(screen.getByLabelText('Organisation'), 'acme');
  await user.type(screen.getByLabelText('Email'), 'ana@acme.test');
  await user.type(screen.getByLabelText('Password'), 'correct horse battery');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LoginPage', () => {
  it('Phase 12: signing in names the organisation, and sends it with the email and password', async () => {
    const calls = stubApi();
    const user = userEvent.setup();
    renderLogin();

    await signIn(user);

    expect(await screen.findByText('Home page')).toBeInTheDocument();
    expect(calls.find((call) => call.path === '/api/auth/login').body).toEqual({
      email: 'ana@acme.test',
      password: 'correct horse battery',
      tenantSlug: 'acme',
    });
  });

  it('returns to where the visitor was going, when that is inside the app', async () => {
    stubApi();
    const user = userEvent.setup();
    renderLogin('/console');
    await signIn(user);
    expect(await screen.findByText('Console page')).toBeInTheDocument();
  });

  it('a destination that could leave the site goes to the home page instead', async () => {
    stubApi();
    const user = userEvent.setup();
    renderLogin('/\\evil.example');
    await signIn(user);
    expect(await screen.findByText('Home page')).toBeInTheDocument();
  });

  it('a failed sign-in names all three fields together, and says nothing about which was wrong', async () => {
    stubApi({ loginStatus: 401 });
    const user = userEvent.setup();
    renderLogin();
    await signIn(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That organisation, email and password combination was not recognised.',
    );
  });
});

describe('safeRedirect', () => {
  it.each([
    ['/console', '/console'],
    ['/console/tickets/64b7f0c2a1b2c3d4e5cccccc?status=open', '/console/tickets/64b7f0c2a1b2c3d4e5cccccc?status=open'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['/%5Cevil.example', '/'],
    ['/%5c%5cevil.example', '/'],
    ['https://evil.example', '/'],
    ['javascript:alert(1)', '/'],
    ['console', '/'],
    ['/\t/evil.example', '/'],
    [undefined, '/'],
    [{ pathname: '/console' }, '/'],
  ])('%j → %j', (from, expected) => {
    expect(safeRedirect(from)).toBe(expected);
  });
});
