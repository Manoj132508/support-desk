import { isPolicyKind } from './outcomes.js';

/**
 * The conversation, as a reducer: stream frames in, transcript out.
 *
 * A pure function, for the same reason the policy engine is one. The screen
 * built on it has a rule that matters more than any styling:
 *
 *   ONLY A SERVER DECISION CAN MARK AN ORDER CANCELLED.
 *
 * No stream frame -- not a token, not `done`, not a `proposal` -- can set an
 * outcome. Only `proposalDecided`, dispatched after the confirm or reject route
 * returned success, can. If the transcript could say "cancelled" because of
 * something in the stream, the screen would be one bug away from telling a
 * customer an action happened that the policy engine refused. As a reducer, the
 * rule is a handful of assertions rather than something to hope a component
 * gets right.
 *
 * Every frame's data is copied field by field. The server already sends only
 * customer-safe fields; copying explicitly means a field that ever appeared by
 * mistake -- a rule key, a snippet -- would not be stored, and so could never be
 * rendered.
 */

export const TURN_STATE = Object.freeze({
  STREAMING: 'streaming',
  COMPLETE: 'complete',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

export const PROPOSAL_STATUS = Object.freeze({ PENDING: 'pending', DECIDED: 'decided' });

/** The two outcomes a customer's decision can produce. */
const DECIDED_OUTCOMES = new Set(['executed', 'rejected_by_customer']);

export const initialConversation = Object.freeze({ turns: [], streaming: false });

function lastIndex(turns, predicate) {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (predicate(turns[index])) return index;
  }
  return -1;
}

/**
 * Apply an update to the reply that is currently streaming.
 *
 * A frame with no streaming turn to belong to is IGNORED. It is never attached
 * to a finished turn, because a late frame -- a proposal arriving after `done`,
 * say -- would otherwise put a confirmation into a conversation that had moved
 * on.
 */
function updateStreamingReply(state, update) {
  const index = lastIndex(
    state.turns,
    (turn) => turn.role === 'assistant' && turn.state === TURN_STATE.STREAMING,
  );
  if (index === -1) return state;
  const turns = state.turns.slice();
  turns[index] = update(turns[index]);
  return { ...state, turns };
}

/** Apply an update to the turn holding a PENDING proposal with this id. A
 *  decision for an unknown or already-decided proposal changes nothing. */
function updatePendingProposal(state, proposalId, update) {
  const index = lastIndex(
    state.turns,
    (turn) => turn.proposal?.id === proposalId && turn.proposal.status === PROPOSAL_STATUS.PENDING,
  );
  if (index === -1) return state;
  const turns = state.turns.slice();
  turns[index] = update(turns[index]);
  return { ...state, turns };
}

const endStreaming = (state) => ({ ...state, streaming: false });

export function conversationReducer(state, action) {
  switch (action?.type) {
    case 'send': {
      // One turn at a time: a second message while a reply is still streaming
      // would interleave two replies' frames.
      if (state.streaming) return state;
      const text = typeof action.text === 'string' ? action.text.trim() : '';
      if (!text) return state;
      return {
        streaming: true,
        turns: [
          ...state.turns,
          { id: action.id, role: 'customer', text },
          {
            id: `${action.id}:reply`,
            role: 'assistant',
            text: '',
            state: TURN_STATE.STREAMING,
            evidence: [],
            proposal: null,
            policy: null,
            outcome: null,
            error: null,
          },
        ],
      };
    }

    case 'token':
      if (typeof action.text !== 'string') return state;
      return updateStreamingReply(state, (turn) => ({ ...turn, text: turn.text + action.text }));

    case 'evidence': {
      const data = action.data;
      if (typeof data?.ref !== 'string' || !data.ref) return state;
      return updateStreamingReply(state, (turn) =>
        turn.evidence.some((item) => item.ref === data.ref)
          ? turn
          : {
              ...turn,
              evidence: [
                ...turn.evidence,
                {
                  ref: data.ref,
                  n: Number.isInteger(data.n) ? data.n : null,
                  documentName: typeof data.documentName === 'string' ? data.documentName : null,
                  section: typeof data.section === 'string' ? data.section : null,
                },
              ],
            },
      );
    }

    case 'proposal': {
      const data = action.data;
      // Everything the confirmation dialog needs, or nothing. A proposal
      // without server-rendered confirmation text cannot be confirmed
      // honestly, so it is not shown at all.
      if (
        typeof data?.id !== 'string' ||
        typeof data.actionType !== 'string' ||
        typeof data.confirmText !== 'string' ||
        !data.confirmText
      ) {
        return state;
      }
      return updateStreamingReply(state, (turn) =>
        // ADR 0009 property 7: one proposal, one dialog. The server already
        // enforces this; the screen does not rely on it.
        turn.proposal
          ? turn
          : {
              ...turn,
              proposal: {
                id: data.id,
                actionType: data.actionType,
                target: { orderNumber: typeof data.target?.orderNumber === 'string' ? data.target.orderNumber : null },
                confirmText: data.confirmText,
                status: PROPOSAL_STATUS.PENDING,
              },
            },
      );
    }

    case 'policy': {
      const data = action.data;
      // Only the policy kinds. A `fault` arrives as an `error` frame, and
      // rendering it through the policy language would disguise breakage as a
      // decision (Phase 4 §5).
      if (!isPolicyKind(data?.kind)) return state;
      return updateStreamingReply(state, (turn) => ({
        ...turn,
        policy: {
          kind: data.kind,
          outcome: typeof data.outcome === 'string' ? data.outcome : null,
          customerMessage: typeof data.customerMessage === 'string' ? data.customerMessage : null,
        },
      }));
    }

    case 'error':
      return endStreaming(
        updateStreamingReply(state, (turn) => ({ ...turn, state: TURN_STATE.FAILED, error: { kind: 'fault' } })),
      );

    case 'failed':
      // The transport failed before or during the stream.
      return endStreaming(
        updateStreamingReply(state, (turn) => ({ ...turn, state: TURN_STATE.FAILED, error: { kind: 'fault' } })),
      );

    case 'done':
      return endStreaming(updateStreamingReply(state, (turn) => ({ ...turn, state: TURN_STATE.COMPLETE })));

    case 'cancelled':
      // The partial text stays, visibly marked -- never silently completed and
      // never silently removed (FR-1.3).
      return endStreaming(updateStreamingReply(state, (turn) => ({ ...turn, state: TURN_STATE.CANCELLED })));

    case 'proposalDecided': {
      // THE ONLY PATH TO AN OUTCOME. Dispatched after the confirm or reject
      // route returned success, with the outcome the SERVER reported.
      if (!DECIDED_OUTCOMES.has(action.outcome)) return state;
      return updatePendingProposal(state, action.proposalId, (turn) => ({
        ...turn,
        proposal: { ...turn.proposal, status: PROPOSAL_STATUS.DECIDED },
        outcome: {
          outcome: action.outcome,
          cancellationRef: typeof action.cancellationRef === 'string' ? action.cancellationRef : null,
        },
      }));
    }

    case 'proposalRefused': {
      // The confirm or reject route answered with an error. A policy kind --
      // `stale`, most often, when the order moved on -- settles the proposal:
      // it can no longer be confirmed. A `fault` does not settle anything, so
      // the proposal stays pending and the customer can try again.
      const kind = action.kind === 'fault' || isPolicyKind(action.kind) ? action.kind : 'fault';
      return updatePendingProposal(state, action.proposalId, (turn) => ({
        ...turn,
        proposal: {
          ...turn.proposal,
          status: kind === 'fault' ? PROPOSAL_STATUS.PENDING : PROPOSAL_STATUS.DECIDED,
        },
        policy: {
          kind,
          outcome: null,
          customerMessage: typeof action.customerMessage === 'string' ? action.customerMessage : null,
        },
      }));
    }

    default:
      return state;
  }
}
