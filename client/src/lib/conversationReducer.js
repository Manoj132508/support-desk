import { isPolicyKind } from './outcomes.js';

/**
 * The conversation, as a reducer: stream frames in, transcript out.
 *
 * A pure function, for the same reason the policy engine is one. The screen
 * built on it has two rules that matter more than any styling:
 *
 *   ONLY A SERVER DECISION CAN MARK AN ORDER CANCELLED.
 *   ONLY THE SERVER CAN SAY A COLLEAGUE IS COMING.
 *
 * No stream frame -- not a token, not `done`, not a `proposal` -- can set an
 * outcome. Only `proposalDecided`, dispatched after the confirm or reject route
 * returned success, can. And a conversation is marked escalated only by a
 * notice or an error the server flagged `escalated: true`, or by the escalate
 * route answering success (ADR 0010). If the transcript could claim either
 * because of something in the stream, the screen would be one bug away from
 * telling a customer something that did not happen.
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

/** One per conversation, because a conversation has at most one active ticket. */
export const ESCALATION_STATUS = Object.freeze({
  REQUESTING: 'requesting',
  ESCALATED: 'escalated',
  FAILED: 'failed',
});

/** The two outcomes a customer's decision can produce. */
const DECIDED_OUTCOMES = new Set(['executed', 'rejected_by_customer']);

export const initialConversation = Object.freeze({ turns: [], streaming: false, escalation: null });

const escalated = (state) => ({ ...state, escalation: { status: ESCALATION_STATUS.ESCALATED } });

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
        ...state,
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
            offerEscalation: false,
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
      const next = updateStreamingReply(state, (turn) => ({
        ...turn,
        policy: {
          kind: data.kind,
          outcome: typeof data.outcome === 'string' ? data.outcome : null,
          proposalId: typeof data.proposalId === 'string' ? data.proposalId : null,
          customerMessage: typeof data.customerMessage === 'string' ? data.customerMessage : null,
          escalated: data.escalated === true,
        },
      }));
      // A notice the server flagged as escalated means the ticket exists.
      return next !== state && data.escalated === true ? escalated(next) : next;
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
      return endStreaming(
        updateStreamingReply(state, (turn) => ({
          ...turn,
          state: TURN_STATE.COMPLETE,
          // An answer the AI service could not ground offers a person. An
          // OFFER only: the advisory tier never escalates on its own (ADR 0010).
          offerEscalation: action.data?.shouldEscalate === true,
        })),
      );

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
        // A fault notice left by a failed earlier attempt describes nothing
        // once the retry has succeeded. A policy notice cannot be on this turn:
        // a turn carries a proposal or a policy notice, never both.
        policy: turn.policy?.kind === 'fault' ? null : turn.policy,
        outcome: {
          outcome: action.outcome,
          cancellationRef: typeof action.cancellationRef === 'string' ? action.cancellationRef : null,
        },
      }));
    }

    case 'proposalRefused': {
      // The confirm or reject route answered with an error. A policy kind --
      // `stale`, most often, when the order moved on -- settles the proposal:
      // it can no longer be confirmed. A `fault` settles nothing, so the
      // proposal stays pending and the customer can try again -- UNLESS the
      // server escalated it, which means the failure was recorded as terminal
      // and retrying could not work.
      const kind = action.kind === 'fault' || isPolicyKind(action.kind) ? action.kind : 'fault';
      const wasEscalated = action.escalated === true;
      const next = updatePendingProposal(state, action.proposalId, (turn) => ({
        ...turn,
        proposal: {
          ...turn.proposal,
          status: kind === 'fault' && !wasEscalated ? PROPOSAL_STATUS.PENDING : PROPOSAL_STATUS.DECIDED,
        },
        policy: {
          kind,
          outcome: null,
          proposalId: action.proposalId,
          customerMessage: typeof action.customerMessage === 'string' ? action.customerMessage : null,
          escalated: wasEscalated,
        },
      }));
      return next !== state && wasEscalated ? escalated(next) : next;
    }

    case 'escalationRequested':
      // Nothing to ask for while a request is in flight or a colleague is
      // already coming.
      if (state.escalation?.status === ESCALATION_STATUS.REQUESTING) return state;
      if (state.escalation?.status === ESCALATION_STATUS.ESCALATED) return state;
      return { ...state, escalation: { status: ESCALATION_STATUS.REQUESTING } };

    case 'escalationSucceeded':
      // Dispatched only after the escalate route answered success.
      return state.escalation?.status === ESCALATION_STATUS.ESCALATED ? state : escalated(state);

    case 'escalationFailed':
      if (state.escalation?.status !== ESCALATION_STATUS.REQUESTING) return state;
      return { ...state, escalation: { status: ESCALATION_STATUS.FAILED } };

    default:
      return state;
  }
}
