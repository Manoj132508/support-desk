import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TicketPage from '../routes/console/TicketPage.jsx';
import { ApiError } from '../lib/api.js';

/**
 * One ticket, for staff (FR-9, FR-10.2, FR-10.3). What is asserted: only the
 * moves the server says are legal are offered, a move is the server's to make,
 * and a blocked action is shown with the rule that blocked it and both of its
 * channels.
 */

const TICKET_ID = '64b7f0c2a1b2c3d4e5cccccc';
const AT = '2026-09-15T09:00:00.000Z';

const TICKET = {
  id: TICKET_ID,
  conversationId: 'conv-1',
  customerId: 'cust-1',
  status: 'open',
  active: true,
  assigneeId: null,
  reason: 'policy_agent_only',
  priority: 'normal',
  openedAt: AT,
  closedAt: null,
  legalMoves: ['assigned'],
};

const DETAIL = {
  ticket: TICKET,
  events: [
    { seq: 1, type: 'created', fromStatus: null, toStatus: 'open', actor: { kind: 'system', userId: null }, reason: 'policy_agent_only', proposalId: 'p1', at: AT },
  ],
  conversation: { id: 'conv-1', customerId: 'cust-1', status: 'escalated', startedAt: AT },
  messages: [
    { id: 'm1', role: 'customer', content: 'Please cancel order 1044', state: 'complete', evidence: [], proposalId: null, at: AT },
    { id: 'm2', role: 'assistant', content: 'Let me check that order.', state: 'complete', evidence: [], proposalId: 'p1', at: AT },
  ],
  attempts: [
    {
      proposalId: 'p1',
      at: AT,
      kind: 'escalated_at_proposal',
      blocked: true,
      validity: 'resolved',
      problemCodes: [],
      actionType: 'order.cancel',
      orderNumber: '1044',
      confirmText: 'Cancel order 1044',
      decisions: [
        {
          stage: 'proposal',
          outcome: 'agent-only',
          ruleKey: 'BASE-CANCEL-DISPATCHED',
          ruleVersion: 1,
          matched: ['order.status eq "dispatched"'],
          defaulted: false,
          reason: null,
          internalReason: 'Post-dispatch cancellation needs a carrier interception request.',
          customerMessage: 'This order has already been dispatched, so I can’t cancel it myself.',
        },
      ],
    },
    {
      proposalId: 'p2',
      at: AT,
      kind: 'malformed',
      blocked: true,
      validity: 'malformed',
      problemCodes: ['asserted_authorisation'],
      actionType: null,
      orderNumber: null,
      confirmText: null,
      decisions: [],
    },
  ],
};

function renderTicket(client) {
  render(
    <MemoryRouter initialEntries={[`/console/tickets/${TICKET_ID}`]}>
      <Routes>
        <Route path="/console/tickets/:id" element={<TicketPage client={client} />} />
        <Route path="/console" element={<p>Queue page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const clientWith = ({ get = async () => DETAIL, post } = {}) => ({ get: vi.fn(get), post: vi.fn(post) });
const region = (name) => screen.getByRole('region', { name });

afterEach(cleanup);

describe('TicketPage', () => {
  it('FR-10.2, FR-10.3, ADR 0007: the transcript, and each attempt with the rule version that decided it and both channels', async () => {
    const client = clientWith();
    renderTicket(client);

    expect(await screen.findByRole('heading', { name: 'Ticket #cccccc' })).toBeInTheDocument();
    expect(client.get).toHaveBeenCalledWith(`/api/tickets/${TICKET_ID}`);
    expect(within(region('Conversation')).getByText('Please cancel order 1044')).toBeInTheDocument();

    const attempts = region('What the assistant tried');
    expect(within(attempts).getByText('Cancel order 1044')).toBeInTheDocument();
    expect(within(attempts).getByText('Escalated to an agent')).toBeInTheDocument();
    expect(within(attempts).getByText('BASE-CANCEL-DISPATCHED · v1')).toBeInTheDocument();
    expect(within(attempts).getByText('Post-dispatch cancellation needs a carrier interception request.')).toBeInTheDocument();
    expect(within(attempts).getByText(/already been dispatched, so I can’t cancel it myself/)).toBeInTheDocument();

    expect(within(attempts).getByText('Could not be understood')).toBeInTheDocument();
    expect(within(attempts).getByText('asserted_authorisation')).toBeInTheDocument();
  });

  it('FR-9: only the moves the server says are legal are offered — an open ticket can be taken, not closed', async () => {
    renderTicket(clientWith());
    const moves = await screen.findByRole('region', { name: 'Move this ticket' });
    expect(within(moves).getAllByRole('button').map((button) => button.textContent)).toEqual(['Take ticket']);
  });

  it('a move is the server’s to make: the ticket shows as the server returns it, and its history reloads', async () => {
    const user = userEvent.setup();
    const assigned = { ...TICKET, status: 'assigned', assigneeId: 'agent-1', legalMoves: ['waiting', 'resolved'] };
    let loads = 0;
    const client = clientWith({
      get: async () => {
        loads += 1;
        return loads === 1
          ? DETAIL
          : {
              ...DETAIL,
              ticket: assigned,
              events: [
                ...DETAIL.events,
                { seq: 2, type: 'assigned', fromStatus: 'open', toStatus: 'assigned', actor: { kind: 'user', userId: 'agent-1' }, reason: 'agent_action', proposalId: null, at: AT },
              ],
            };
      },
      post: async () => ({ ticket: assigned }),
    });
    renderTicket(client);

    await user.click(await screen.findByRole('button', { name: 'Take ticket' }));

    expect(client.post).toHaveBeenCalledWith(`/api/tickets/${TICKET_ID}/status`, { status: 'assigned' });
    const moves = region('Move this ticket');
    expect(await within(moves).findByRole('button', { name: 'Wait for customer' })).toBeInTheDocument();
    expect(within(moves).getByRole('button', { name: 'Mark resolved' })).toBeInTheDocument();
    expect(within(moves).queryByRole('button', { name: 'Take ticket' })).not.toBeInTheDocument();
    expect(await within(region('History')).findByText('Taken')).toBeInTheDocument();
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Ticket is now Assigned');
  });

  it('another agent moved it first: a 409 says so, moves nothing, and offers a reload', async () => {
    const user = userEvent.setup();
    const client = clientWith({
      post: async () => {
        throw new ApiError({ kind: 'stale', message: 'The ticket changed before this update was applied.', status: 409 });
      },
    });
    renderTicket(client);

    await user.click(await screen.findByRole('button', { name: 'Take ticket' }));

    const moves = region('Move this ticket');
    expect(await within(moves).findByRole('note')).toHaveTextContent('Someone else moved this ticket first');
    expect(within(moves).getByRole('button', { name: 'Take ticket' })).toBeInTheDocument();

    await user.click(within(moves).getByRole('button', { name: 'Reload ticket' }));
    await waitFor(() => expect(client.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(region('Move this ticket')).queryByRole('note')).not.toBeInTheDocument());
  });

  it('a closed ticket is settled, and offers no moves', async () => {
    renderTicket(clientWith({ get: async () => ({ ...DETAIL, ticket: { ...TICKET, status: 'closed', active: false, legalMoves: [] } }) }));
    const moves = await screen.findByRole('region', { name: 'Move this ticket' });
    expect(within(moves).queryAllByRole('button')).toHaveLength(0);
    expect(within(moves).getByText(/settled and cannot be moved/)).toBeInTheDocument();
  });

  it('the history says why the ticket is here and how it has moved', async () => {
    renderTicket(
      clientWith({
        get: async () => ({
          ...DETAIL,
          ticket: { ...TICKET, status: 'assigned', legalMoves: ['waiting', 'resolved'] },
          events: [
            ...DETAIL.events,
            { seq: 2, type: 'assigned', fromStatus: 'open', toStatus: 'assigned', actor: { kind: 'user', userId: 'a1' }, reason: 'agent_action', proposalId: null, at: AT },
            { seq: 3, type: 'status_changed', fromStatus: 'assigned', toStatus: 'resolved', actor: { kind: 'user', userId: 'a1' }, reason: 'agent_action', proposalId: null, at: AT },
            { seq: 4, type: 'escalated', fromStatus: 'resolved', toStatus: 'assigned', actor: { kind: 'user', userId: 'c1' }, reason: 'customer_request', proposalId: null, at: AT },
          ],
        }),
      }),
    );

    const history = await screen.findByRole('region', { name: 'History' });
    expect(within(history).getByText('Ticket opened')).toBeInTheDocument();
    expect(within(history).getByText('Policy needs a person')).toBeInTheDocument();
    expect(within(history).getByText('Taken')).toBeInTheDocument();
    expect(within(history).getByText('Assigned → Resolved')).toBeInTheDocument();
    expect(within(history).getByText('Escalated again · Resolved → Assigned')).toBeInTheDocument();
    expect(within(history).getByText('Customer asked for a person')).toBeInTheDocument();
  });

  it('INV-D: a missing ticket reads the same as one in another tenant', async () => {
    renderTicket(clientWith({ get: async () => { throw new ApiError({ kind: 'fault', message: 'Not found', status: 404 }); } }));
    expect(await screen.findByText('This ticket does not exist, or is not in your queue.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('any other load failure is a fault with a retry', async () => {
    const user = userEvent.setup();
    let loads = 0;
    renderTicket(
      clientWith({
        get: async () => {
          loads += 1;
          if (loads === 1) throw new ApiError({ kind: 'fault', message: 'down', status: 500 });
          return DETAIL;
        },
      }),
    );

    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Ticket #cccccc' })).toBeInTheDocument();
  });
});
