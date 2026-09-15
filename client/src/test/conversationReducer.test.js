import { describe, expect, it } from 'vitest';
import {
  conversationReducer,
  initialConversation,
  TURN_STATE,
  PROPOSAL_STATUS,
  ESCALATION_STATUS,
} from '../lib/conversationReducer.js';

/**
 * The transcript reducer. The rules these tests exist for: ONLY A SERVER
 * DECISION CAN MARK AN ORDER CANCELLED, and ONLY THE SERVER CAN SAY A
 * COLLEAGUE IS COMING. No stream frame can do either.
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
        data: {
          kind: 'refused',
          outcome: 'refused_at_proposal',
          proposalId: 'p9',
          customerMessage: 'This order has already shipped.',
          escalated: false,
          detail: { ruleKey: 'X' },
        },
      },
    ]);
    expect(reply(state).policy).toEqual({
      kind: 'refused',
      outcome: 'refused_at_proposal',
      proposalId: 'p9',
      customerMessage: 'This order has already shipped.',
      escalated: false,
    });
    expect(state.escalation).toBeNull();
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
    expect(reply(state).policy).toEqual({
      kind: 'stale',
      outcome: null,
      proposalId: 'p1',
      customerMessage: 'This order has now been dispatched.',
      escalated: false,
    });
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

describe('ONLY THE SERVER CAN SAY A COLLEAGUE IS COMING (ADR 0010)', () => {
  const policy = (data) => ({ type: 'policy', data: { kind: 'refused', outcome: 'escalated_at_proposal', proposalId: 'p3', customerMessage: 'A colleague will check.', ...data } });

  it('a notice the server flagged as escalated marks the turn and the conversation', () => {
    const state = reduce([send(), policy({ escalated: true })]);
    expect(reply(state).policy.escalated).toBe(true);
    expect(state.escalation).toEqual({ status: ESCALATION_STATUS.ESCALATED });
  });

  it('anything but a literal true is not an escalation', () => {
    for (const value of [undefined, 'true', 1, null]) {
      const state = reduce([send(), policy({ escalated: value })]);
      expect(reply(state).policy.escalated).toBe(false);
      expect(state.escalation).toBeNull();
    }
  });

  it('a late notice with no streaming turn marks nothing', () => {
    const state = reduce([send(), { type: 'done', data: {} }, policy({ escalated: true })]);
    expect(state.escalation).toBeNull();
  });

  it('an ungrounded answer offers a person; a grounded one does not', () => {
    expect(reply(reduce([send(), { type: 'done', data: { shouldEscalate: true } }])).offerEscalation).toBe(true);
    expect(reply(reduce([send(), { type: 'done', data: { grounded: true } }])).offerEscalation).toBe(false);
    expect(reply(reduce([send(), { type: 'done', data: { shouldEscalate: 'yes' } }])).offerEscalation).toBe(false);
  });

  it('an offer escalates nothing by itself', () => {
    expect(reduce([send(), { type: 'done', data: { shouldEscalate: true } }]).escalation).toBeNull();
  });

  it('asking: requesting, then escalated only when the route answers success', () => {
    const requesting = reduce([send(), { type: 'done', data: {} }, { type: 'escalationRequested' }]);
    expect(requesting.escalation).toEqual({ status: ESCALATION_STATUS.REQUESTING });
    expect(conversationReducer(requesting, { type: 'escalationRequested' })).toBe(requesting);
    expect(conversationReducer(requesting, { type: 'escalationSucceeded' }).escalation).toEqual({
      status: ESCALATION_STATUS.ESCALATED,
    });
  });

  it('a failed request can be made again, and once escalated there is nothing more to ask', () => {
    const failed = reduce([{ type: 'escalationRequested' }, { type: 'escalationFailed' }]);
    expect(failed.escalation).toEqual({ status: ESCALATION_STATUS.FAILED });
    expect(conversationReducer(failed, { type: 'escalationRequested' }).escalation.status).toBe(ESCALATION_STATUS.REQUESTING);

    const done = reduce([{ type: 'escalationRequested' }, { type: 'escalationSucceeded' }]);
    expect(conversationReducer(done, { type: 'escalationRequested' })).toBe(done);
    expect(conversationReducer(done, { type: 'escalationFailed' })).toBe(done);
  });

  it('a refusal at execution that escalated settles the proposal and marks the conversation', () => {
    const pending = reduce([send(), proposalFrame, { type: 'done', data: {} }]);
    const state = conversationReducer(pending, {
      type: 'proposalRefused',
      proposalId: 'p1',
      kind: 'stale',
      customerMessage: "I'll bring in a colleague.",
      escalated: true,
    });
    expect(reply(state).proposal.status).toBe(PROPOSAL_STATUS.DECIDED);
    expect(reply(state).policy.escalated).toBe(true);
    expect(state.escalation.status).toBe(ESCALATION_STATUS.ESCALATED);
  });

  it('a terminal failure that escalated settles the proposal: retrying could not work', () => {
    const pending = reduce([send(), proposalFrame, { type: 'done', data: {} }]);
    const state = conversationReducer(pending, { type: 'proposalRefused', proposalId: 'p1', kind: 'fault', escalated: true });
    expect(reply(state).proposal.status).toBe(PROPOSAL_STATUS.DECIDED);
    expect(state.escalation.status).toBe(ESCALATION_STATUS.ESCALATED);
  });

  it('the conversation stays escalated as it carries on', () => {
    const state = reduce([send(), policy({ escalated: true }), { type: 'done', data: {} }, send('Thanks', 't2')]);
    expect(state.escalation.status).toBe(ESCALATION_STATUS.ESCALATED);
  });
});

describe('purity', () => {
  it('never mutates the state it was given', () => {
    const frozen = deepFreeze(reduce([send(), proposalFrame]));
    expect(() =>
      reduce(
        [
          { type: 'token', text: 'more' },
          { type: 'done', data: { shouldEscalate: true } },
          { type: 'proposalDecided', proposalId: 'p1', outcome: 'executed' },
          { type: 'escalationRequested' },
          { type: 'escalationSucceeded' },
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
