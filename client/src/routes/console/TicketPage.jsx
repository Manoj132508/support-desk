import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Badge, { OutcomeBadge } from '../../components/primitives/Badge.jsx';
import Button from '../../components/primitives/Button.jsx';
import PolicyBlock from '../../components/PolicyBlock.jsx';
import { api } from '../../lib/api.js';
import { OUTCOME_LABEL } from '../../lib/outcomes.js';
import {
  ATTEMPT_KIND_LABEL,
  REASON_LABEL,
  ROLE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  eventLabel,
  formatWhen,
  moveLabel,
  shortId,
} from '../../lib/tickets.js';
import styles from './Console.module.css';

/**
 * One ticket, for staff. FR-9, FR-10.2, FR-10.3.
 *
 * An EXPLANATION tool before it is a queue (Phase 4 §2): the most valuable thing
 * on this screen is what the assistant tried to do and which rule stopped it,
 * shown with both channels -- the internal reason and the sentence the customer
 * was actually told (ADR 0007).
 *
 * THE MOVES COME FROM THE SERVER. Each ticket arrives with `legalMoves`, taken
 * from the state machine, and only those are rendered -- so `open → closed` is
 * never offered. The server still refuses anything else (FR-9.2). The screen
 * narrowing the options is convenience; both exist on purpose.
 *
 * Not here, and said plainly in the Phase 11 doc: replying to the customer,
 * and FR-10.4's proposed replies. Nothing drafts replies, and the customer's
 * screen cannot yet receive a message it did not stream.
 */

function AttemptCard({ attempt }) {
  const title =
    attempt.validity === 'malformed'
      ? 'A request the assistant could not form'
      : attempt.actionType === 'order.cancel'
        ? `Cancel order ${attempt.orderNumber ?? ''}`.trim()
        : attempt.actionType;

  return (
    <li className={[styles.attempt, attempt.blocked ? styles.blocked : ''].join(' ')}>
      <div className={styles.attemptHeader}>
        <span className={styles.attemptTitle}>{title}</span>
        {Object.hasOwn(OUTCOME_LABEL, attempt.kind) ? (
          <OutcomeBadge outcome={attempt.kind} />
        ) : (
          <Badge tone={attempt.kind === 'malformed' ? 'policy' : 'neutral'}>
            {ATTEMPT_KIND_LABEL[attempt.kind] ?? attempt.kind}
          </Badge>
        )}
      </div>

      {attempt.problemCodes.length > 0 && (
        <p className={styles.codes}>
          Problems: <code>{attempt.problemCodes.join(', ')}</code>
        </p>
      )}

      {attempt.decisions.map((decision, index) => (
        <dl key={`${decision.stage}-${index}`} className={styles.decision}>
          <div>
            <dt>Decided</dt>
            <dd>{decision.stage === 'execution' ? 'At confirmation' : 'When proposed'}</dd>
          </div>
          <div>
            <dt>Rule</dt>
            <dd>
              <code>{decision.ruleKey ? `${decision.ruleKey} · v${decision.ruleVersion}` : 'No rule matched'}</code>
              {decision.defaulted ? ' — denied by default' : ''}
            </dd>
          </div>
          <div>
            <dt>Outcome</dt>
            <dd>
              <code>{decision.outcome}</code>
            </dd>
          </div>
          {decision.matched.length > 0 && (
            <div>
              <dt>Matched</dt>
              <dd>
                <code>{decision.matched.join(', ')}</code>
              </dd>
            </div>
          )}
          {decision.reason && (
            <div>
              <dt>Reason</dt>
              <dd>
                <code>{decision.reason}</code>
              </dd>
            </div>
          )}
          {decision.internalReason && (
            <div>
              <dt>Why</dt>
              <dd>{decision.internalReason}</dd>
            </div>
          )}
          {decision.customerMessage && (
            <div>
              <dt>Customer told</dt>
              <dd>“{decision.customerMessage}”</dd>
            </div>
          )}
        </dl>
      ))}
    </li>
  );
}

export default function TicketPage({ client = api }) {
  const { id } = useParams();
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [moving, setMoving] = useState(null);
  const [moveError, setMoveError] = useState(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    client
      .get(`/api/tickets/${encodeURIComponent(id)}`)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [client, id, reloadKey]);

  function reload() {
    setMoveError(null);
    setReloadKey((key) => key + 1);
  }

  function move(to) {
    setMoving(to);
    setMoveError(null);
    client
      .post(`/api/tickets/${encodeURIComponent(id)}/status`, { status: to })
      .then(({ ticket }) => {
        // The answer is the ticket as it now is. The event that recorded the
        // move arrives with the reload that follows.
        setDetail((current) => (current ? { ...current, ticket } : current));
        setAnnouncement(`Ticket is now ${STATUS_LABEL[ticket.status] ?? ticket.status}`);
        setReloadKey((key) => key + 1);
      })
      .catch((error) => setMoveError(error))
      .finally(() => setMoving(null));
  }

  if (loadError && !detail) {
    return (
      <div className={styles.page}>
        <p className={styles.back}>
          <Link to="/console">← Back to the queue</Link>
        </p>
        {loadError.status === 404 ? (
          // INV-D: a ticket in another tenant and one that does not exist look
          // the same, so the sentence covers both.
          <p className={styles.empty}>This ticket does not exist, or is not in your queue.</p>
        ) : (
          <PolicyBlock kind="fault" customerMessage="The ticket could not be loaded." onRetry={reload} />
        )}
      </div>
    );
  }

  if (!detail) {
    return (
      <div className={styles.page}>
        <p role="status">Loading ticket…</p>
      </div>
    );
  }

  const { ticket, events, messages, attempts } = detail;

  return (
    <div className={styles.page}>
      <p className={styles.back}>
        <Link to="/console">← Back to the queue</Link>
      </p>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <div className={styles.ticketHeader}>
        <h1 className={styles.title}>Ticket #{shortId(ticket.id)}</h1>
        <Badge tone={STATUS_TONE[ticket.status] ?? 'neutral'}>{STATUS_LABEL[ticket.status] ?? ticket.status}</Badge>
      </div>
      <p className={styles.meta}>
        {REASON_LABEL[ticket.reason] ?? 'No reason recorded'} · opened {formatWhen(ticket.openedAt)} ·{' '}
        {ticket.assigneeId ? 'assigned' : 'unassigned'}
      </p>

      <div className={styles.panes}>
        <section className={styles.pane} aria-labelledby="transcript-heading">
          <h2 id="transcript-heading">Conversation</h2>
          {messages.length === 0 ? (
            <p className={styles.empty}>No messages.</p>
          ) : (
            <ol className={styles.transcript}>
              {messages.map((message) => (
                <li key={message.id} className={styles.message}>
                  <span className={styles.role}>{ROLE_LABEL[message.role] ?? message.role}</span>
                  <p className={styles.text}>{message.content}</p>
                  {message.state === 'cancelled' && <span className={styles.marker}>Stopped by the customer</span>}
                  <span className={styles.when}>{formatWhen(message.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <div className={styles.side}>
          <section className={styles.pane} aria-labelledby="moves-heading">
            <h2 id="moves-heading">Move this ticket</h2>
            {ticket.legalMoves.length === 0 ? (
              <p className={styles.empty}>A closed ticket is settled and cannot be moved.</p>
            ) : (
              <div className={styles.moves}>
                {ticket.legalMoves.map((to) => (
                  <Button
                    key={to}
                    size="sm"
                    variant={to === 'closed' ? 'secondary' : 'primary'}
                    onClick={() => move(to)}
                    loading={moving === to}
                    disabled={moving !== null && moving !== to}
                  >
                    {moveLabel(ticket.status, to)}
                  </Button>
                ))}
              </div>
            )}
            {moveError &&
              (moveError.status === 409 ? (
                <>
                  <PolicyBlock
                    kind="stale"
                    customerMessage="Someone else moved this ticket first. Reload it to see where it is now."
                  />
                  <Button variant="secondary" size="sm" onClick={reload}>
                    Reload ticket
                  </Button>
                </>
              ) : (
                <PolicyBlock kind="fault" customerMessage="The ticket could not be updated." />
              ))}
          </section>

          <section className={styles.pane} aria-labelledby="attempts-heading">
            <h2 id="attempts-heading">What the assistant tried</h2>
            {attempts.length === 0 ? (
              <p className={styles.empty}>No actions were attempted in this conversation.</p>
            ) : (
              <ol className={styles.attempts}>
                {attempts.map((attempt) => (
                  <AttemptCard key={attempt.proposalId} attempt={attempt} />
                ))}
              </ol>
            )}
          </section>

          <section className={styles.pane} aria-labelledby="history-heading">
            <h2 id="history-heading">History</h2>
            <ol className={styles.events}>
              {events.map((event) => (
                <li key={event.seq}>
                  <span>{eventLabel(event)}</span>
                  {event.reason && <span className={styles.reason}>{REASON_LABEL[event.reason] ?? event.reason}</span>}
                  <span className={styles.when}>
                    {event.actor.kind === 'system' ? 'System' : 'A person'} · {formatWhen(event.at)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}
