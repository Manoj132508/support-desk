import { useCallback, useEffect, useReducer, useState } from 'react';
import Button from '../components/primitives/Button.jsx';
import ConfirmationDialog from '../components/ConfirmationDialog.jsx';
import PolicyBlock from '../components/PolicyBlock.jsx';
import { api, ApiError } from '../lib/api.js';
import { citedSources } from '../lib/citedSources.js';
import { isPolicyKind } from '../lib/outcomes.js';
import { useEventStream } from '../lib/useEventStream.js';
import {
  conversationReducer,
  ESCALATION_STATUS,
  initialConversation,
  PROPOSAL_STATUS,
  TURN_STATE,
} from '../lib/conversationReducer.js';
import styles from './ConversationPage.module.css';

/**
 * The customer conversation. Where everything in Phases 10 and 11 reaches a
 * person.
 *
 * Split in two on purpose:
 *
 *   ConversationView  what the customer sees, driven entirely by props.
 *   ConversationPage  the wiring: the stream, the reducer, the confirm, reject
 *                     and escalate calls.
 *
 * Three rules this screen keeps, each inherited from a decision made earlier:
 *
 *   1. ONLY A SERVER DECISION MARKS AN ORDER CANCELLED. "Order 1043 was
 *      cancelled" appears only after the confirm route returned `executed`
 *      (the reducer enforces this; see conversationReducer.js).
 *   2. THE CONSEQUENTIAL CLICK EXISTS IN ONE PLACE. The transcript shows a
 *      proposal with a "Review" button; only the confirmation dialog can
 *      authorise anything (ADR 0009).
 *   3. ONLY THE SERVER CAN SAY A COLLEAGUE IS COMING (ADR 0010). A policy
 *      notice is not an error (Phase 4 §5), and it ends in a next step: either
 *      the server escalated, and the notice says a colleague will pick it up,
 *      or the notice offers "Talk to a person". Pressing it escalates nothing
 *      until the escalate route answers success.
 */

const COLLEAGUE_COMING = 'A colleague will pick this up';

function newTurnId() {
  return globalThis.crypto?.randomUUID?.() ?? `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** What the screen-reader status region says. The STATE, never the token
 *  stream (Phase 4 §8). A failure says nothing here: its alert announces it. */
function statusFor(state, announcement) {
  if (state.streaming) return 'Assistant is responding';
  if (announcement) return announcement;
  const last = state.turns.at(-1);
  if (last?.state === TURN_STATE.CANCELLED) return 'Response stopped';
  if (last?.state === TURN_STATE.COMPLETE) return 'Response complete';
  return '';
}

const proposalElementId = (proposalId) => `proposal-${proposalId}`;

function AssistantTurn({ turn, escalation, onReview, onEscalate }) {
  const orderNumber = turn.proposal?.target?.orderNumber;
  const conversationEscalated = escalation?.status === ESCALATION_STATUS.ESCALATED;
  const requesting = escalation?.status === ESCALATION_STATUS.REQUESTING;
  const policyKind = turn.policy ? isPolicyKind(turn.policy.kind) : false;
  const sources = citedSources(turn.evidence, turn.text, { streaming: turn.state === TURN_STATE.STREAMING });

  return (
    <li className={styles.assistant}>
      {turn.text && <p className={styles.text}>{turn.text}</p>}
      {turn.state === TURN_STATE.STREAMING && !turn.text && (
        <p className={styles.pending} aria-hidden="true">
          …
        </p>
      )}
      {turn.state === TURN_STATE.CANCELLED && <p className={styles.marker}>Stopped</p>}

      {sources.length > 0 && (
        <ol className={styles.sources} aria-label="Sources">
          {sources.map((item) => (
            // `value` keeps the number the answer's [n] marker uses, even when
            // only some sources are listed.
            <li key={item.ref} value={item.n ?? undefined}>
              {[item.documentName, item.section].filter(Boolean).join(' — ') || item.ref}
            </li>
          ))}
        </ol>
      )}

      {turn.proposal && (
        // Focusable from script only (tabIndex -1), so focus has somewhere to
        // land when a decision settles this proposal.
        <div className={styles.proposal} id={proposalElementId(turn.proposal.id)} tabIndex={-1}>
          {/* Server-rendered text from the order record (FR-6.1), set apart
              from anything the assistant said. */}
          <p className={styles.proposalText}>{turn.proposal.confirmText}</p>

          {turn.proposal.status === PROPOSAL_STATUS.PENDING && (
            <Button variant="secondary" size="sm" onClick={() => onReview(turn.proposal.id)}>
              Review
            </Button>
          )}

          {/* Only reachable after the server reported the outcome. */}
          {turn.outcome?.outcome === 'executed' && (
            <p className={styles.settled}>
              Order {orderNumber} was cancelled.
              {turn.outcome.cancellationRef ? ` Reference ${turn.outcome.cancellationRef}.` : ''}
            </p>
          )}
          {turn.outcome?.outcome === 'rejected_by_customer' && (
            <p className={styles.settled}>You kept order {orderNumber}. Nothing was changed.</p>
          )}
        </div>
      )}

      {turn.policy && (
        <PolicyBlock
          kind={turn.policy.kind}
          customerMessage={turn.policy.customerMessage}
          // A colleague is coming if the server escalated this notice, or the
          // conversation by any route since. A fault claims it only for itself.
          escalated={turn.policy.escalated || (policyKind && conversationEscalated)}
          onEscalate={policyKind ? () => onEscalate(turn.policy.proposalId) : undefined}
          escalating={requesting}
        />
      )}
      {turn.error && (
        <PolicyBlock kind="fault" customerMessage="The assistant is unavailable right now. Please try again shortly." />
      )}

      {turn.offerEscalation && !conversationEscalated && (
        <div className={styles.offer}>
          <span className={styles.offerText}>A person may be able to help with this.</span>
          <Button variant="secondary" size="sm" onClick={() => onEscalate(null)} loading={requesting}>
            Talk to a person
          </Button>
        </div>
      )}
    </li>
  );
}

export function ConversationView({
  turns,
  streaming,
  starting,
  statusText,
  pageError,
  openProposal,
  busyProposalId,
  settledProposalId,
  escalation,
  canEscalate,
  onSend,
  onStop,
  onReview,
  onConfirm,
  onReject,
  onDismiss,
  onEscalate,
  onRetryEscalation,
}) {
  const [draft, setDraft] = useState('');
  const escalated = escalation?.status === ESCALATION_STATUS.ESCALATED;

  /**
   * After a decision, focus goes to the proposal it settled.
   *
   * The dialog returns focus to whatever opened it, which is right when that
   * still exists. After a decision it usually does not: the Review button
   * disappears the moment the proposal is decided, and focus returned to a
   * removed element falls to the top of the document. This effect runs after
   * the dialog's own cleanup in the same commit, so it has the last word --
   * and it only runs when a decision settled something. After a fault the
   * proposal stays open, and focus goes back to Review, ready to retry.
   */
  useEffect(() => {
    if (settledProposalId) document.getElementById(proposalElementId(settledProposalId))?.focus();
  }, [settledProposalId]);

  function submit(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || streaming || starting) return;
    // Cleared only once the message is on its way, so a conversation that
    // fails to start does not also lose what the customer typed.
    Promise.resolve(onSend(text)).then((sent) => {
      if (sent) setDraft('');
    });
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Support</h1>
        {canEscalate && !escalated && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onEscalate(null)}
            loading={escalation?.status === ESCALATION_STATUS.REQUESTING}
          >
            Talk to a person
          </Button>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {statusText}
      </p>

      {pageError && <PolicyBlock kind="fault" customerMessage={pageError} />}

      {/* Shown only once the server has said the ticket exists. No promise of
          a reply here: an agent cannot yet write back through this screen. */}
      {escalated && <p className={styles.notice}>{COLLEAGUE_COMING}. They can see this conversation.</p>}
      {escalation?.status === ESCALATION_STATUS.FAILED && (
        <PolicyBlock
          kind="fault"
          customerMessage="We couldn't reach a colleague just now. Please try again."
          onRetry={onRetryEscalation}
        />
      )}

      <ol className={styles.transcript} aria-label="Conversation">
        {turns.length === 0 && <li className={styles.empty}>Ask about an order, a delivery or a return.</li>}
        {turns.map((turn) =>
          turn.role === 'customer' ? (
            <li key={turn.id} className={styles.customer}>
              <p className={styles.text}>{turn.text}</p>
            </li>
          ) : (
            <AssistantTurn
              key={turn.id}
              turn={turn}
              escalation={escalation}
              onReview={onReview}
              onEscalate={onEscalate}
            />
          ),
        )}
      </ol>

      <form className={styles.composer} onSubmit={submit}>
        <label htmlFor="composer" className={styles.label}>
          Your message
        </label>
        <textarea
          id="composer"
          className={styles.input}
          rows={3}
          maxLength={4000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className={styles.actions}>
          {streaming ? (
            <Button variant="secondary" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button type="submit" disabled={!draft.trim()} loading={starting}>
              Send
            </Button>
          )}
        </div>
      </form>

      <ConfirmationDialog
        open={Boolean(openProposal)}
        proposal={openProposal}
        busy={Boolean(openProposal) && busyProposalId === openProposal.id}
        onConfirm={() => onConfirm(openProposal)}
        onReject={() => onReject(openProposal)}
        onDismiss={onDismiss}
      />
    </div>
  );
}

export default function ConversationPage({ client = api }) {
  const [state, dispatch] = useReducer(conversationReducer, initialConversation);
  const [conversationId, setConversationId] = useState(null);
  const [starting, setStarting] = useState(false);
  const [openProposalId, setOpenProposalId] = useState(null);
  const [busyProposalId, setBusyProposalId] = useState(null);
  const [settledProposalId, setSettledProposalId] = useState(null);
  const [escalationProposalId, setEscalationProposalId] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const [pageError, setPageError] = useState(null);
  const { start, stop } = useEventStream();

  /** Resolves true once the message is on its way, false if it never left. */
  const send = useCallback(
    async (text) => {
      // `start` aborts any stream already running, so a second send mid-reply
      // must be stopped here, not only by the reducer.
      if (state.streaming) return false;
      setPageError(null);
      setAnnouncement('');

      let id = conversationId;
      if (!id) {
        setStarting(true);
        try {
          const { conversation } = await client.post('/api/conversations');
          if (!conversation?._id) throw new Error('No conversation id in the response');
          id = conversation._id;
          setConversationId(id);
        } catch {
          setPageError('We could not start a conversation just now. Please try again.');
          return false;
        } finally {
          setStarting(false);
        }
      }

      dispatch({ type: 'send', id: newTurnId(), text });

      // Deliberately not awaited: the stream lasts as long as the reply. `start`
      // never rejects -- every ending, whether done, Stop or a failure, arrives
      // through one of these handlers instead.
      start(`/api/conversations/${encodeURIComponent(id)}/messages`, { content: text }, {
        token: (value) => dispatch({ type: 'token', text: value }),
        evidence: (data) => dispatch({ type: 'evidence', data }),
        proposal: (data) => {
          dispatch({ type: 'proposal', data });
          // Open the dialog for the FIRST proposal only. A second one is
          // ignored by the reducer and must not replace a dialog being read.
          if (typeof data?.id === 'string') setOpenProposalId((current) => current ?? data.id);
        },
        policy: (data) => {
          dispatch({ type: 'policy', data });
          if (data?.escalated === true) setAnnouncement(COLLEAGUE_COMING);
        },
        error: (data) => dispatch({ type: 'error', data }),
        done: (data) => dispatch({ type: 'done', data }),
        // A stream that ends without a `done` frame still ends the turn.
        complete: () => dispatch({ type: 'done', data: {} }),
        cancelled: () => dispatch({ type: 'cancelled' }),
        failed: () => dispatch({ type: 'failed' }),
      });
      return true;
    },
    [client, conversationId, start, state.streaming],
  );

  const decide = useCallback(
    async (proposal, verb) => {
      setBusyProposalId(proposal.id);
      try {
        const { outcome } = await client.post(`/api/proposals/${encodeURIComponent(proposal.id)}/${verb}`);
        dispatch({
          type: 'proposalDecided',
          proposalId: proposal.id,
          outcome: outcome?.outcome,
          cancellationRef: outcome?.cancellationRef,
        });
        const orderNumber = proposal.target?.orderNumber;
        if (outcome?.outcome === 'executed') {
          setAnnouncement(`Order ${orderNumber} was cancelled`);
          setSettledProposalId(proposal.id);
        } else if (outcome?.outcome === 'rejected_by_customer') {
          setAnnouncement(`Order ${orderNumber} was kept`);
          setSettledProposalId(proposal.id);
        }
      } catch (error) {
        const kind = error instanceof ApiError ? error.kind : 'fault';
        const wasEscalated = error instanceof ApiError && error.escalated;
        dispatch({
          type: 'proposalRefused',
          proposalId: proposal.id,
          kind,
          customerMessage: error instanceof ApiError ? error.customerMessage : null,
          escalated: wasEscalated,
        });
        // A policy answer settles the proposal, exactly as the reducer treats
        // it, and so does a failure the server escalated as terminal. A plain
        // fault does not, and focus returns to the button that opened the
        // dialog, which is still there.
        if (isPolicyKind(kind) || wasEscalated) setSettledProposalId(proposal.id);
        if (wasEscalated) setAnnouncement(COLLEAGUE_COMING);
      } finally {
        setBusyProposalId(null);
        setOpenProposalId(null);
      }
    },
    [client],
  );

  /**
   * Ask for a person (FR-8.2). `proposalId` is sent when the customer asks from
   * a refusal; the server believes it only if it can see that refusal. The
   * conversation is marked escalated only when the route answers success.
   */
  const escalate = useCallback(
    async (proposalId = null) => {
      if (!conversationId) return;
      const status = state.escalation?.status;
      if (status === ESCALATION_STATUS.REQUESTING || status === ESCALATION_STATUS.ESCALATED) return;

      setEscalationProposalId(proposalId);
      dispatch({ type: 'escalationRequested' });
      try {
        await client.post(
          `/api/conversations/${encodeURIComponent(conversationId)}/escalate`,
          proposalId ? { proposalId } : {},
        );
        dispatch({ type: 'escalationSucceeded' });
        setAnnouncement(COLLEAGUE_COMING);
      } catch {
        dispatch({ type: 'escalationFailed' });
      }
    },
    [client, conversationId, state.escalation],
  );

  // Derived, not stored: the dialog shows a proposal only while the reducer
  // still holds it as pending, so a decided proposal cannot be reopened.
  const openProposal = openProposalId
    ? (state.turns
        .map((turn) => turn.proposal)
        .find((proposal) => proposal?.id === openProposalId && proposal.status === PROPOSAL_STATUS.PENDING) ?? null)
    : null;

  return (
    <ConversationView
      turns={state.turns}
      streaming={state.streaming}
      starting={starting}
      statusText={statusFor(state, announcement)}
      pageError={pageError}
      openProposal={openProposal}
      busyProposalId={busyProposalId}
      settledProposalId={settledProposalId}
      escalation={state.escalation}
      canEscalate={Boolean(conversationId)}
      onSend={send}
      onStop={stop}
      onReview={setOpenProposalId}
      onConfirm={(proposal) => decide(proposal, 'confirm')}
      onReject={(proposal) => decide(proposal, 'reject')}
      // ADR 0009 property 4: dismissing decides nothing. The proposal stays
      // pending and its card keeps the Review button.
      onDismiss={() => setOpenProposalId(null)}
      onEscalate={escalate}
      onRetryEscalation={() => escalate(escalationProposalId)}
    />
  );
}
