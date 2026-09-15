import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext.jsx';
import AccountPage from '../routes/AccountPage.jsx';
import LoginPage from '../routes/LoginPage.jsx';
import { ApiError } from '../lib/api.js';

/**
 * FR-13.4 from the customer's side: what the page promises, what it asks for,
 * and what happens after.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function renderAccount(client) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path) => {
      if (path === '/api/auth/me') {
        return new Response(JSON.stringify({ user: { id: 'u1', role: 'customer', email: 'ana@acme.test', tenantId: 't1' } }), {
          status: 200,
          headers: JSON_HEADERS,
        });
      }
      throw new Error(`Unexpected request ${path}`);
    }),
  );
  render(
    <MemoryRouter initialEntries={['/account']}>
      <AuthProvider>
        <Routes>
          <Route path="/account" element={<AccountPage client={client} />} />
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function confirmWith(user, password = 'correct horse battery') {
  await user.type(screen.getByLabelText('Your password'), password);
  await user.click(screen.getByRole('checkbox', { name: 'I understand this cannot be undone' }));
  await user.click(screen.getByRole('button', { name: 'Delete my account' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AccountPage', () => {
  it('FR-13.4, ADR 0006: says plainly what is removed and what is kept', () => {
    renderAccount({ post: vi.fn() });
    const removed = screen.getByRole('region', { name: 'What is removed' });
    const kept = screen.getByRole('region', { name: 'What is kept, without your name or email' });
    expect(removed).toHaveTextContent('Your conversations with the assistant, and every message in them.');
    expect(kept).toHaveTextContent('A record of each action the assistant proposed on your orders');
    expect(kept).toHaveTextContent('it is not deleted');
  });

  it('the button does nothing until the password is typed and the consequence acknowledged', async () => {
    const user = userEvent.setup();
    renderAccount({ post: vi.fn() });
    const button = screen.getByRole('button', { name: 'Delete my account' });

    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Your password'), 'correct horse battery');
    expect(button).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'I understand this cannot be undone' }));
    expect(button).toBeEnabled();
  });

  it('deleting sends the password, leaves the signed-in screens, and says the account is gone', async () => {
    const user = userEvent.setup();
    const client = { post: vi.fn(async () => null) };
    renderAccount(client);

    await confirmWith(user);

    expect(client.post).toHaveBeenCalledWith('/api/account/delete', { password: 'correct horse battery' });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your account has been deleted.');
  });

  it('a wrong password changes nothing, and says so', async () => {
    const user = userEvent.setup();
    const client = {
      post: vi.fn(async () => {
        throw new ApiError({ kind: 'fault', message: 'Password confirmation failed', status: 403 });
      }),
    };
    renderAccount(client);

    await confirmWith(user, 'a guess');

    expect(await screen.findByRole('alert')).toHaveTextContent('That password was not right. Your account has not been changed.');
    expect(screen.getByRole('heading', { name: 'Delete your account' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeEnabled();
  });

  it('too many attempts asks the customer to wait', async () => {
    const user = userEvent.setup();
    const client = {
      post: vi.fn(async () => {
        throw new ApiError({ kind: 'fault', message: 'Too many requests', status: 429 });
      }),
    };
    renderAccount(client);
    await confirmWith(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts');
  });
});
