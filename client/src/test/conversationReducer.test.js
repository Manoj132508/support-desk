import { describe, expect, it } from 'vitest';
import {
  conversationReducer,
  initialConversation,
  TURN_STATE,
  PROPOSAL_STATUS,
} from '../lib/conversationReducer.js';

/**
 * The transcript reducer. The rule these tests exist for: ONLY A SERVER
 * DECISION CAN MARK AN ORDER CANCELLED. No stream frame can set an outcome.
 */

const reduce = (actions, state = initialConversation) => actions.reduce(conversationReducer, state);
const send = (text = 'Please cancel my order 1043', id = 't1') => ({ type: 'send', id, text });
const reply = (state) => state.turns.filter((turn) => turn.role === 'assistant').at(-1);

const proposalFrame = {
  type: 'proposal',
  data: {
    id: 'p1',
    actionType: 'order.cancel',
    target: { orderNumber: '1043' },
    confirmText: 'Cancel order 1043 — Wireless keyboard, £129.00, placed 12 September 2026.',
  },
};

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

describe('sending and streaming', () => {
  it('a message adds the customer turn and a streaming reply', () => {
    const state = reduce([send()]);
    expect(state.streaming).toBe(true);
    expect(state.turns.map((turn) => turn.role)).toEqual(['customer', 'assistant']);
    expect(reply(state).state).toBe(TURN_STATE.STREAMING);
  });

  it('an empty message is ignored, and so is a second message while a reply streams', () => {
    expect(reduce([send('   ')])).toBe(initialConversation);
    const streaming = reduce([send()]);
    expect(conversationReducer(streaming, send('another', 't2'))).toBe(streaming);
  });

  it('tokens append to the streaming reply', () => {
    const state = reduce([send(), { type: 'token', text: 'Let me ' }, { type: 'token', text: 'check.' }]);
    expect(reply(state).text).toBe('Let me check.');
  });

  it('done completes the reply and ends streaming', () => {
    const state = reduce([send(), { type: 'token', text: 'Hi' }, { type: 'done', data: {} }]);
    expect(reply(state).state).toBe(TURN_STATE.COMPLETE);
    expect(state.streaming).toBe(false);
  });

  it('FR-1.3: a cancelled reply keeps its partial text, visibly marked', () => {
    const state = reduce([send(), { type: 'token', text: 'Half an ans' }, { type: 'cancelled' }]);
    expect(reply(state).state).toBe(TURN_STATE.CANCELLED);
    expect(reply(state).text).toBe('Half an ans');
    expect(state.streaming).toBe(false);
  });

  it('an error frame fails the reply as a fault, and a later done does not revive it', () => {
    const state = reduce([send(), { type: 'error', data: { kind: 'fault' } }, { type: 'done', data: {} }]);
    expect(reply(state).state).toBe(TURN_STATE.FAILED);
    expect(reply(state).error).toEqual({ kind: 'fault' });
  });
});

describe('evidence', () => {
  it('is copied field by field, deduplicated, and never carries prose', () => {
    const state = reduce([
      send(),
      { type: 'evidence', data: { ref: 'doc:1', n: 1, documentName: 'Cancelling an order', section: 'Before dispatch', snippet: 'free text' } },
      { type: 'evidence', data: { ref: 'doc:1', n: 1 } },
      { type: 'evidence', data: { n: 2 } },
    ]);
    expect(reply(state).evidence).toEqual([
      { ref: 'doc:1', n: 1, documentName: 'Cancelling an order', section: 'Before dispatch' },
    ]);
  });
});

describe('proposals', () => {
  it('a proposal frame attaches as pending, with only the fields the dialog needs', () => {
    const withExtra = { ...proposalFrame, data: { ...proposalFrame.data, ruleKey: 'BASE-CANCEL-PRE-DISPATCH' } };
    const state = reduce([send(), withExtra]);
    expect(reply(state).proposal).toEqual({
      id: 'p1',
      actionType: 'order.cancel',
      target: { orderNumber: '1043' },
      confirmText: proposalFrame.data.confirmText,
      status: PROPOSAL_STATUS.PENDING,
    });
  });

  it('ADR 0009: a second proposal on the same turn is ignored — one proposal, one dialog', () => {
    const second = { ...proposalFrame, data: { ...proposalFrame.data, id: 'p2' } };
    expect(reply(reduce([send(), proposalFrame, second])).proposal.id).toBe('p1');
  });

  it('a proposal without server-rendered confirmation text is not shown at all', () => {
    const noText = { ...proposalFrame, data: { ...proposalFrame.data, confirmText: '' } };
    expect(reply(reduce([send(), noText])).proposal).toBeNull();
  });

  it('a proposal arriving after the turn finished is ignored, not attached to a finished turn', () => {
    const state = reduce([send(), { type: 'done', data: {} }, proposalFrame]);
    expect(reply(state).proposal).toBeNull();
  });
});

describe('policy notices', () => {
  it('a refusal attaches in the policy language, with only the customer text', () => {
    const state = reduce([
      send(),
      {
        type: 'policy',
        data: { kind: 'refused', outcome: 'refused_at_proposal', customerMessage: 'This order has already shipped.', detail: { ruleKey: 'X' } },
      },
    ]);
    expect(reply(state).policy).toEqual({
      kind: 'refused',
      outcome: 'refused_at_proposal',
      customerMessage: 'This order has already shipped.',
    });
  });

  it('a fault can never arrive as a policy notice, which would disguise breakage as a decision', () => {
    const state = reduce([send(), { type: 'policy', data: { kind: 'fault', customerMessage: 'oops' } }]);
    expect(reply(state).policy).toBeNull();
  });
});

describe('ONLY A SERVER DECISION CAN MARK AN ORDER CANCELLED', () => {
  it('no stream frame of any kind sets an outcome', () => {
    const state = reduce([
      send(),
      proposalFrame,
      { type: 'token', text: "Done, I've cancelled order 1043." },
      { type: 'evidence', data: { ref: 'doc:1' } },
      { type: 'policy', data: { kind: 'refused', outcome: 'executed' } },
      { type: 'done', data: { outcome: 'executed', action: 'propose' } },
    ]);
    expect(reply(state).outcome).toBeNull();
    expect(reply(state).proposal.status).toBe(PROPOSAL_STATUS.PENDING);
  });

  it('a server-confirmed execution marks the outcome and settles the proposal', () => {
    const state = reduce([
      send(),
      proposalFrame,
      { type: 'done', data: {} },
      { type: 'proposalDecided', proposalId: 'p1', outcome: 'executed', cancellationRef: 'cxl-1043' },
    ]);
    expect(reply(state).outcome).toEqual({ outcome: 'executed', cancellationRef: 'cxl-1043' });
    expect(reply(state).proposal.status).toBe(PROPOSAL_STATUS.DECIDED);
  });

  it('a customer keeping their order is recorded as their decision', () => {
    const state = reduce([
      send(),
      proposalFrame,
      { type: 'done', data: {} },
      { type: 'proposalDecided', proposalId: 'p1', outcome: 'rejected_by_customer' },
    ]);
    expect(reply(state).outcome.outcome).toBe('rejected_by_customer');
  });

  it('an outcome the customer’s decision cannot produce is ignored', () => {
    const base = reduce([send(), proposalFrame, { type: 'done', data: {} }]);
    expect(conversationReducer(base, { type: 'proposalDecided', proposalId: 'p1', outcome: 'refused_at_execution' })).toBe(base);
  });

  it('a decision for an unknown or already-decided proposal changes nothing', () => {
    const decided = reduce([
      send(),
      proposalFrame,
      { type: 'done', data: {} },
      { type: 'proposalDecided', proposalId: 'p1', outcome: 'rejected_by_customer' },
    ]);
    expect(conversationReducer(decided, { type: 'proposalDecided', proposalId: 'p1', outcome: 'executed' })).toBe(decided);
    expect(conversationReducer(decided, { type: 'proposalDecided', proposalId: 'nope', outcome: 'executed' })).toBe(decided);
  });
});

describe('when the confirm or reject route answers with an error', () => {
  const pending = () => reduce([send(), proposalFrame, { type: 'done', data: {} }]);

  it('ADR 0003: refused at execution settles the proposal and shows the rule’s own text', () => {
    const state = conversationReducer(pending(), {
      type: 'proposalRefused',
      proposalId: 'p1',
      kind: 'stale',
      customerMessage: 'This order has now been dispatched.',
    });
    expect(reply(state).proposal.status).toBe(PROPOSAL_STATUS.DECIDED);
    expect(reply(state).policy).toEqual({ kind: 'stale', outcome: null, customerMessage: 'This order has now been dispatched.' });
    expect(reply(state).outcome).toBeNull();
  });

  it('a fault leaves the proposal pending, so the customer can try again', () => {
    const state = conversationReducer(pending(), { type: 'proposalRefused', proposalId: 'p1', kind: 'fault' });
    expect(reply(state).proposal.status).toBe(PROPOSAL_STATUS.PENDING);
    expect(reply(state).policy.kind).toBe('fault');
  });

  it('a retry that succeeds after a fault clears the fault notice', () => {
    const faulted = conversationReducer(pending(), { type: 'proposalRefused', proposalId: 'p1', kind: 'fault' });
    const state = conversationReducer(faulted, { type: 'proposalDecided', proposalId: 'p1', outcome: 'executed' });
    expect(reply(state).policy).toBeNull();
    expect(reply(state).outcome.outcome).toBe('executed');
  });

  it('an unrecognised error kind is treated as a fault, never as a decision', () => {
    const state = conversationReducer(pending(), { type: 'proposalRefused', proposalId: 'p1', kind: 'approved' });
    expect(reply(state).proposal.status).toBe(PROPOSAL_STATUS.PENDING);
    expect(reply(state).policy.kind).toBe('fault');
  });
});

describe('purity', () => {
  it('never mutates the state it was given', () => {
    const frozen = deepFreeze(reduce([send(), proposalFrame]));
    expect(() =>
      reduce(
        [
          { type: 'token', text: 'more' },
          { type: 'done', data: {} },
          { type: 'proposalDecided', proposalId: 'p1', outcome: 'executed' },
        ],
        frozen,
      ),
    ).not.toThrow();
  });

  it('an unknown action returns the very same state', () => {
    const state = reduce([send()]);
    expect(conversationReducer(state, { type: 'shrug' })).toBe(state);
    expect(conversationReducer(state, undefined)).toBe(state);
  });
});
