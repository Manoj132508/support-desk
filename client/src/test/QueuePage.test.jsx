import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import QueuePage from '../routes/console/QueuePage.jsx';
import { ApiError } from '../lib/api.js';

/**
 * The agent queue (FR-10.1). The server decides which tickets exist in this
 * tenant; asserted here is what the queue asks for, and how it shows the answer.
 */

const COUNTS = { open: 2, assigned: 1, waiting: 3, resolved: 1, closed: 9 };

const ticket = (id, overrides = {}) => ({
  id,
  conversationId: 'conv',
  customerId: 'cust',
  status: 'open',
  active: true,
  assigneeId: null,
  reason: 'policy_agent_only',
  priority: 'normal',
  openedAt: '2026-09-15T09:00:00.000Z',
  closedAt: null,
  legalMoves: ['assigned'],
  ...overrides,
});

const answer = (tickets, nextCursor = null) => ({ tickets, counts: COUNTS, page: { limit: 25, nextCursor } });

function renderQueue(get, path = '/console') {
  const client = { get: vi.fn(get) };
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/console" element={<QueuePage client={client} />} />
        <Route path="/console/tickets/:id" element={<p>Ticket page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return client;
}

afterEach(cleanup);

describe('QueuePage', () => {
  it('FR-10.1: shows the active queue, and asks the server for exactly that', async () => {
    const client = renderQueue(async () =>
      answer([
        ticket('64b7f0c2a1b2c3d4e5aaaaaa'),
        ticket('64b7f0c2a1b2c3d4e5bbbbbb', { status: 'waiting', reason: 'customer_request' }),
      ]),
    );

    const first = await screen.findByRole('link', { name: 'Ticket #aaaaaa' });
    expect(client.get).toHaveBeenCalledWith('/api/tickets');

    const [, firstRow, secondRow] = screen.getAllByRole('row');
    expect(within(firstRow).getByText('Policy needs a person')).toBeInTheDocument();
    expect(within(secondRow).getByText('Waiting on customer')).toBeInTheDocument();
    expect(within(secondRow).getByText('Customer asked for a person')).toBeInTheDocument();
    expect(first).toHaveAttribute('href', '/console/tickets/64b7f0c2a1b2c3d4e5aaaaaa');

    // Active is everything not closed: 2 + 1 + 3 + 1.
    expect(screen.getByRole('link', { name: 'Active 7' })).toHaveAttribute('aria-current', 'page');
  });

  it('the filter lives in the address bar, and reaches the server as given', async () => {
    const client = renderQueue(async () => answer([ticket('64b7f0c2a1b2c3d4e5aaaaaa', { status: 'waiting' })]), '/console?status=waiting');
    await screen.findByRole('link', { name: 'Ticket #aaaaaa' });
    expect(client.get).toHaveBeenCalledWith('/api/tickets?status=waiting');
    expect(screen.getByRole('link', { name: 'Waiting on customer 3' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Active 7' })).not.toHaveAttribute('aria-current');
  });

  it('choosing a filter asks for that status', async () => {
    const user = userEvent.setup();
    const client = renderQueue(async () => answer([]));
    await screen.findByText('No tickets need attention.');

    await user.click(screen.getByRole('link', { name: 'Resolved 1' }));

    await waitFor(() => expect(client.get).toHaveBeenLastCalledWith('/api/tickets?status=resolved'));
    expect(await screen.findByText('No tickets are resolved.')).toBeInTheDocument();
  });

  it('an unknown status in the address bar shows the default queue rather than an error', async () => {
    const client = renderQueue(async () => answer([]), '/console?status=archived');
    await screen.findByText('No tickets need attention.');
    expect(client.get).toHaveBeenCalledWith('/api/tickets');
  });

  it('more tickets load after the last one, by cursor', async () => {
    const user = userEvent.setup();
    const client = renderQueue(async (path) =>
      path.includes('cursor=')
        ? answer([ticket('64b7f0c2a1b2c3d4e5bbbbbb')])
        : answer([ticket('64b7f0c2a1b2c3d4e5aaaaaa')], 'cursor-1'),
    );

    await screen.findByRole('link', { name: 'Ticket #aaaaaa' });
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('link', { name: 'Ticket #bbbbbb' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ticket #aaaaaa' })).toBeInTheDocument();
    expect(client.get).toHaveBeenLastCalledWith('/api/tickets?cursor=cursor-1');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('a queue that cannot be loaded is a fault with a retry', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderQueue(async () => {
      calls += 1;
      if (calls === 1) throw new ApiError({ kind: 'fault', message: 'down', status: 500 });
      return answer([ticket('64b7f0c2a1b2c3d4e5aaaaaa')]);
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The queue could not be loaded.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('link', { name: 'Ticket #aaaaaa' })).toBeInTheDocument();
  });

  it('a ticket in the queue opens its ticket page', async () => {
    const user = userEvent.setup();
    renderQueue(async () => answer([ticket('64b7f0c2a1b2c3d4e5aaaaaa')]));
    await user.click(await screen.findByRole('link', { name: 'Ticket #aaaaaa' }));
    expect(await screen.findByText('Ticket page')).toBeInTheDocument();
  });
});
