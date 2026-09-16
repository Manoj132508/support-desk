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
 * the confirm route said so, the words "a colleague will pick this up" only
 * after the server said a ticket exists, and every other ending says something
 * true instead.
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

const escalateCalls = (client) => client.post.mock.calls.filter(([path]) => path.endsWith('/escalate'));

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

  it('ADR 0011: lists the sources the answer cites, numbered as its markers are', async () => {
    const evidence = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      frame('evidence', { kind: 'kb_chunk', ref: `kb:${n}`, n, documentName: `Article ${n}`, section: null }),
    );
    stubStream([...evidence, frame('token', 'You have 30 days [6], and postage is not refunded [7].'), frame('done', {})]);
    const user = userEvent.setup();
    render(<ConversationPage client={makeClient()} />);

    await ask(user, 'How long do I have to return something?');

    const sources = await screen.findByRole('list', { name: 'Sources' });
    const items = within(sources).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Article 6', 'Article 7']);
    // The list's own numbers are the markers' numbers, not 1 and 2.
    expect(items.map((item) => item.value)).toEqual([6, 7]);
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
    expect(escalateCalls(client)).toHaveLength(0);
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
        customerMessage: 'Cancellations are paused today.',
        status: 409,
      }),
    });
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel order 1043' }));

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Cancellations are paused today.');
    expect(note).not.toHaveTextContent(/colleague/i);
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

describe('ConversationPage — ONLY THE SERVER CAN SAY A COLLEAGUE IS COMING (ADR 0010)', () => {
  const REFUSED = frame('policy', {
    kind: 'refused',
    outcome: 'refused_at_proposal',
    proposalId: 'p9',
    customerMessage: 'This order has already been delivered, so it can’t be cancelled. You can return it instead.',
    escalated: false,
  });
  const ESCALATED = frame('policy', {
    kind: 'refused',
    outcome: 'escalated_at_proposal',
    proposalId: 'p8',
    customerMessage: 'This order has already been dispatched, so I can’t cancel it myself. I’ll bring in a colleague.',
    escalated: true,
  });
  const actionTurn = (policy) => [frame('token', 'Let me check that order.'), policy, frame('done', { action: 'propose' })];
  const ANSWER = { escalation: { ticketId: 't1', status: 'open', created: true } };
  const NOTICE = /They can see this conversation/;

  it('a refusal the rule explained is a calm note that offers a person instead of a dead end', async () => {
    stubStream(actionTurn(REFUSED));
    const client = makeClient();
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('already been delivered');
    expect(note).not.toHaveTextContent(/colleague/i);
    expect(within(note).getByRole('button', { name: 'Talk to a person' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(escalateCalls(client)).toHaveLength(0);
  });

  it('pressing it sends the refused proposal, and only the server’s answer turns it into "a colleague is coming"', async () => {
    stubStream(actionTurn(REFUSED));
    let resolveEscalation;
    const client = makeClient({
      '/api/conversations/c1/escalate': () =>
        new Promise((resolve) => {
          resolveEscalation = resolve;
        }),
    });
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);
    const note = await screen.findByRole('note');
    await user.click(within(note).getByRole('button', { name: 'Talk to a person' }));

    expect(client.post).toHaveBeenCalledWith('/api/conversations/c1/escalate', { proposalId: 'p9' });
    expect(within(note).getByRole('button', { name: 'Talk to a person' })).toBeDisabled();
    expect(note).not.toHaveTextContent(/colleague/i);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();

    resolveEscalation(ANSWER);

    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('A colleague will pick this up');
    expect(screen.queryByRole('button', { name: 'Talk to a person' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('A colleague will pick this up');
  });

  it('a notice the server escalated says so at once, and leaves nothing to press', async () => {
    stubStream(actionTurn(ESCALATED));
    const client = makeClient();
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);

    expect(await screen.findByRole('note')).toHaveTextContent('A colleague will pick this up');
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Talk to a person' })).not.toBeInTheDocument();
    expect(escalateCalls(client)).toHaveLength(0);
  });

  it('a request that fails claims nothing, and can be made again', async () => {
    stubStream([frame('token', 'Your order is on its way.'), frame('done', {})]);
    let attempts = 0;
    const client = makeClient({
      '/api/conversations/c1/escalate': () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new ApiError({ kind: 'fault', message: 'down', status: 500 }))
          : Promise.resolve(ANSWER);
      },
    });
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user, 'Where is my order?');
    await screen.findByText('Your order is on its way.');

    // Any time: the heading's button, with no refusal behind it.
    await user.click(screen.getByRole('button', { name: 'Talk to a person' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("couldn't reach a colleague");
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    expect(client.post).toHaveBeenLastCalledWith('/api/conversations/c1/escalate', {});
    expect(attempts).toBe(2);
  });

  it('an answer the assistant could not ground offers a person, and the offer alone escalates nothing', async () => {
    stubStream([
      frame('token', "I couldn't find an answer to that in our help centre."),
      frame('done', { grounded: false, shouldEscalate: true }),
    ]);
    const client = makeClient();
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user, 'Do you sell gift cards?');

    expect(await screen.findByText('A person may be able to help with this.')).toBeInTheDocument();
    // The offer beside the answer, and the heading's.
    expect(screen.getAllByRole('button', { name: 'Talk to a person' })).toHaveLength(2);
    expect(escalateCalls(client)).toHaveLength(0);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('at execution: an order that shipped before confirming is refused, a colleague is already coming, and nothing is left to press', async () => {
    stubStream(PROPOSAL_TURN);
    const client = makeClient({
      '/api/proposals/p1/confirm': new ApiError({
        kind: 'stale',
        message: 'Refused at execution',
        customerMessage: 'This order has already been dispatched, so I can’t cancel it myself. I’ll bring in a colleague.',
        status: 409,
        escalated: true,
      }),
    });
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel order 1043' }));

    expect(await screen.findByRole('note')).toHaveTextContent('A colleague will pick this up');
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Talk to a person' })).not.toBeInTheDocument();
  });

  it('a failure the server recorded as terminal says a colleague has it, and offers no retry', async () => {
    stubStream(PROPOSAL_TURN);
    const client = makeClient({
      '/api/proposals/p1/confirm': new ApiError({ kind: 'fault', message: 'Execution failed', status: 500, escalated: true }),
    });
    const user = userEvent.setup();
    render(<ConversationPage client={client} />);

    await ask(user);
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel order 1043' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/passed this to a colleague/);
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    expect(screen.queryByText(/order 1043 was cancelled/i)).not.toBeInTheDocument();
  });
});
