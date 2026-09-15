import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConversationPage from '../routes/ConversationPage.jsx';
import { ApiError } from '../lib/api.js';

/**
 * The customer conversation, end to end inside the browser: real reducer, real
 * stream parser, real dialog. Only the two things outside the browser are
 * replaced -- the JSON client (injected) and `fetch` for the stream (stubbed).
 *
 * What these tests exist to hold: the words "was cancelled" appear only after
 * the confirm route said so, and every other ending -- a refusal, a fault, a
 * dismissal, Stop -- says something true instead.
 */

const encoder = new TextEncoder();
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const PROPOSAL = {
  id: 'p1',
  actionType: 'order.cancel',
  target: { kind: 'order', orderNumber: '1043' },
  confirmText: 'Cancel order 1043 — Wireless keyboard, £129.00, placed 12 September 2026.',
};

const PROPOSAL_TURN = [
  frame('token', 'Let me check that order.'),
  frame('proposal', PROPOSAL),
  frame('done', { action: 'propose' }),
];

/**
 * Answer the message route with these frames.
 *
 * `hold` keeps the stream open: until it is aborted, which is how Stop is
 * exercised, or until the test calls `push` and `end` to deliver more frames
 * later, which is how a frame arriving under an open dialog is exercised.
 */
function stubStream(frames, { hold = false, ok = true } = {}) {
  let streamController = null;
  const fetchMock = vi.fn((path, options) => {
    if (!ok) return Promise.resolve({ ok: false, status: 502, body: null });
    const body = new ReadableStream({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(frames.join('')));
        if (!hold) {
          controller.close();
          return;
        }
        options.signal.addEventListener('abort', () =>
          controller.error(new DOMException('The operation was aborted.', 'AbortError')),
        );
      },
    });
    return Promise.resolve({ ok: true, status: 200, body });
  });
  fetchMock.push = (...more) => streamController.enqueue(encoder.encode(more.join('')));
  fetchMock.end = () => streamController.close();
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A JSON client. Each answer is a value, an Error to reject with, or a
 *  function returning a promise. */
function makeClient(answers = {}) {
  return {
    post: vi.fn((path) => {
      const answer =
        path in answers ? answers[path] : path === '/api/conversations' ? { conversation: { _id: 'c1' } } : undefined;
      if (typeof answer === 'function') return answer();
      if (answer instanceof Error) return Promise.reject(answer);
      if (answer !== undefined) return Promise.resolve(answer);
      return Promise.reject(new Error(`Unexpected POST ${path}`));
    }),
  };
}

async function ask(user, text = 'Please cancel my order 1043') {
  await user.type(screen.getByLabelText('Your message'), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

const executed = (cancellationRef = 'CXL-1043') => ({
  outcome: { proposalId: 'p1', outcome: 'executed', at: '2026-09-15T10:00:00.000Z', cancellationRef },
  duplicate: false,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConversationPage — sending', () => {
  it('starts a conversation, streams the reply, and clears the draft', async () => {
    const fetchMock = stubStream([frame('token', 'Orders can be cancelled before dispatch.'), frame('done', {})]);
    const client = makeClient();
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user, 'Can I cancel an order?');

    expect(await screen.findByText('Orders can be cancelled before dispatch.')).toBeInTheDocument();
    expect(client.post).toHaveBeenCalledWith('/api/conversations');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/c1/messages',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ content: 'Can I cancel an order?' }) }),
    );
    expect(screen.getByLabelText('Your message')).toHaveValue('');
    expect(screen.getByRole('status')).toHaveTextContent('Response complete');
  });

  it('keeps what was typed when the conversation cannot be started', async () => {
    const fetchMock = stubStream([]);
    const client = makeClient({ '/api/conversations': new ApiError({ kind: 'fault', message: 'down', status: 500 }) });
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user, 'Where is my order?');

    expect(await screen.findByRole('alert')).toHaveTextContent('could not start a conversation');
    expect(screen.getByLabelText('Your message')).toHaveValue('Where is my order?');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a stream that fails to open is shown as a fault, not a refusal', async () => {
    stubStream([], { ok: false });
    const user = userEvent.setup();
    render(<ConversationPage client={makeClient()} />);

    await ask(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('The assistant is unavailable');
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('FR-1.3: Stop keeps the partial reply, visibly marked as stopped', async () => {
    stubStream([frame('token', 'Half an ans')], { hold: true });
    const user = userEvent.setup();
    render(<ConversationPage client={makeClient()} />);

    await ask(user);
    expect(await screen.findByText('Half an ans')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));

    expect(await screen.findByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('Half an ans')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Response stopped');
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});

describe('ConversationPage — ONLY A SERVER DECISION MARKS AN ORDER CANCELLED', () => {
  it('a proposal opens the dialog with the server’s text, and nothing says cancelled', async () => {
    stubStream([
      frame('token', 'Done — I’ve cancelled order 1043.'),
      frame('proposal', PROPOSAL),
      frame('done', { action: 'propose', outcome: 'executed' }),
    ]);
    const user = userEvent.setup();
    render(<ConversationPage client={makeClient()} />);

    await ask(user);

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(PROPOSAL.confirmText)).toBeInTheDocument();
    expect(screen.queryByText(/order 1043 was cancelled/i)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).not.toHaveTextContent(/cancelled/i);
  });

  it('confirming reports the cancellation only once the server has executed it', async () => {
    stubStream(PROPOSAL_TURN);
    let resolveConfirm;
    const client = makeClient({
      '/api/proposals/p1/confirm': () =>
        new Promise((resolve) => {
          resolveConfirm = resolve;
        }),
    });
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel order 1043' }));

    // In flight: the request has left, the answer has not arrived.
    expect(client.post).toHaveBeenCalledWith('/api/proposals/p1/confirm');
    expect(within(dialog).getByRole('button', { name: 'Cancel order 1043' })).toBeDisabled();
    expect(screen.queryByText(/order 1043 was cancelled/i)).not.toBeInTheDocument();

    resolveConfirm(executed());

    expect(await screen.findByText('Order 1043 was cancelled. Reference CXL-1043.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Order 1043 was cancelled');
    // The button that opened the dialog may no longer exist, so focus goes to
    // the settled proposal rather than falling to the top of the document.
    expect(document.getElementById('proposal-p1')).toHaveFocus();
  });

  it('"Keep my order" is recorded as the customer’s decision', async () => {
    stubStream(PROPOSAL_TURN);
    const client = makeClient({
      '/api/proposals/p1/reject': { outcome: { proposalId: 'p1', outcome: 'rejected_by_customer' }, duplicate: false },
    });
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep my order' }));

    expect(await screen.findByText('You kept order 1043. Nothing was changed.')).toBeInTheDocument();
    expect(client.post).toHaveBeenCalledWith('/api/proposals/p1/reject');
    expect(client.post).not.toHaveBeenCalledWith('/api/proposals/p1/confirm');
    expect(document.getElementById('proposal-p1')).toHaveFocus();
  });

  it('ADR 0009: dismissing decides nothing, and Review reopens the same proposal', async () => {
    stubStream(PROPOSAL_TURN);
    const client = makeClient();
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(client.post).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/proposals\//));

    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(within(await screen.findByRole('alertdialog')).getByText(PROPOSAL.confirmText)).toBeInTheDocument();
  });

  it('ADR 0009: a frame arriving under the open dialog does not move the customer’s focus', async () => {
    const stream = stubStream([frame('token', 'Let me check that order.'), frame('proposal', PROPOSAL)], { hold: true });
    const user = userEvent.setup();
    render(<ConversationPage client={makeClient()} />);

    await ask(user);
    const keep = within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Keep my order' });
    keep.focus();

    stream.push(frame('done', { action: 'propose' }));
    stream.end();

    // The page has re-rendered: the turn finished while the dialog was open.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Response complete'));
    expect(keep).toHaveFocus();
  });

  it('ADR 0003: a refusal at execution shows the rule’s words and settles the proposal', async () => {
    stubStream(PROPOSAL_TURN);
    const client = makeClient({
      '/api/proposals/p1/confirm': new ApiError({
        kind: 'stale',
        message: 'Refused at execution',
        customerMessage: 'This order has now been dispatched, so it can no longer be cancelled here.',
        status: 409,
      }),
    });
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel order 1043' }));

    expect(await screen.findByRole('note')).toHaveTextContent('This order has now been dispatched');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/order 1043 was cancelled/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    expect(document.getElementById('proposal-p1')).toHaveFocus();
  });

  it('a fault on confirm leaves the proposal open to retry, and a successful retry clears it', async () => {
    stubStream(PROPOSAL_TURN);
    let attempts = 0;
    const client = makeClient({
      '/api/proposals/p1/confirm': () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new ApiError({ kind: 'fault', message: 'Execution failed', status: 500 }))
          : Promise.resolve(executed(null));
      },
    });
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel order 1043' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.queryByText(/order 1043 was cancelled/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel order 1043' }));

    expect(await screen.findByText('Order 1043 was cancelled.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(attempts).toBe(2);
  });
});

describe('ConversationPage — policy notices', () => {
  it('a refusal at proposal is a calm note in the rule’s words, with no dialog and no dead button', async () => {
    stubStream([
      frame('token', 'Let me check that order.'),
      frame('policy', {
        kind: 'refused',
        outcome: 'refused_at_proposal',
        proposalId: 'p9',
        customerMessage: 'This order has already been delivered, so it can’t be cancelled.',
      }),
      frame('done', { action: 'propose' }),
    ]);
    const user = userEvent.setup();
    render(<ConversationPage client={makeClient()} />);

    await ask(user);

    expect(await screen.findByRole('note')).toHaveTextContent('already been delivered');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Escalation is Phase 11. Until then there is no button that does nothing.
    expect(screen.queryByRole('button', { name: /talk to a person/i })).not.toBeInTheDocument();
  });
});
