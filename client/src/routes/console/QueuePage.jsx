import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Badge from '../../components/primitives/Badge.jsx';
import Button from '../../components/primitives/Button.jsx';
import PolicyBlock from '../../components/PolicyBlock.jsx';
import { api } from '../../lib/api.js';
import {
  ACTIVE_STATUSES,
  REASON_LABEL,
  STATUS_LABEL,
  STATUS_ORDER,
  STATUS_TONE,
  formatWhen,
  shortId,
} from '../../lib/tickets.js';
import styles from './Console.module.css';

/**
 * The agent queue. FR-10.1: tickets for the agent's tenant, filterable by state.
 *
 * The tenant is never chosen here -- the server takes it from the session. The
 * filter lives in the address bar, so a filtered queue can be bookmarked,
 * shared with a colleague, and survives a reload.
 *
 * Oldest first, and paged by cursor rather than by page number: tickets arrive
 * while an agent is reading, and offset paging would show some twice and skip
 * others (the same reasoning as the audit, Phase 10 §8).
 */

function queuePath(status, cursor) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return `/api/tickets${query ? `?${query}` : ''}`;
}

export default function QueuePage({ client = api }) {
  const [searchParams] = useSearchParams();
  const requested = searchParams.get('status');
  // An unknown status in the address bar shows the default queue rather than
  // an error: the server would refuse it, and the fix is obvious.
  const status = STATUS_ORDER.includes(requested) ? requested : null;

  const [page, setPage] = useState({ tickets: [], counts: null, nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .get(queuePath(status))
      .then((data) => {
        if (!cancelled) {
          setPage({ tickets: data.tickets ?? [], counts: data.counts ?? null, nextCursor: data.page?.nextCursor ?? null });
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, status, reloadKey]);

  function loadMore() {
    setLoadingMore(true);
    client
      .get(queuePath(status, page.nextCursor))
      .then((data) =>
        setPage((current) => ({
          ...current,
          tickets: [...current.tickets, ...(data.tickets ?? [])],
          nextCursor: data.page?.nextCursor ?? null,
        })),
      )
      .catch((err) => setError(err))
      .finally(() => setLoadingMore(false));
  }

  const { counts } = page;
  const activeCount = counts ? ACTIVE_STATUSES.reduce((sum, key) => sum + (counts[key] ?? 0), 0) : null;
  const filters = [
    { key: null, label: 'Active', count: activeCount },
    ...STATUS_ORDER.map((key) => ({ key, label: STATUS_LABEL[key], count: counts?.[key] ?? null })),
  ];

  let body;
  if (loading) {
    body = <p role="status">Loading tickets…</p>;
  } else if (error && page.tickets.length === 0) {
    body = (
      <PolicyBlock
        kind="fault"
        customerMessage="The queue could not be loaded."
        onRetry={() => setReloadKey((key) => key + 1)}
      />
    );
  } else if (page.tickets.length === 0) {
    body = (
      <p className={styles.empty}>
        {status ? `No tickets are ${STATUS_LABEL[status].toLowerCase()}.` : 'No tickets need attention.'}
      </p>
    );
  } else {
    body = (
      <>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">
              {status ? `${STATUS_LABEL[status]} tickets` : 'Active tickets'}, oldest first
            </caption>
            <thead>
              <tr>
                <th scope="col">Ticket</th>
                <th scope="col">Status</th>
                <th scope="col">Why it is here</th>
                <th scope="col">Opened</th>
              </tr>
            </thead>
            <tbody>
              {page.tickets.map((ticket) => (
                <tr key={ticket.id}>
                  <td>
                    <Link to={`/console/tickets/${ticket.id}`}>Ticket #{shortId(ticket.id)}</Link>
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[ticket.status] ?? 'neutral'}>{STATUS_LABEL[ticket.status] ?? ticket.status}</Badge>
                  </td>
                  <td>{REASON_LABEL[ticket.reason] ?? '—'}</td>
                  <td>{formatWhen(ticket.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && <PolicyBlock kind="fault" customerMessage="More tickets could not be loaded." />}
        {page.nextCursor && (
          <div>
            <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
              Load more
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Queue</h1>

      <nav aria-label="Filter tickets by status">
        <ul className={styles.filters}>
          {filters.map((filter) => {
            const current = filter.key === status;
            return (
              <li key={filter.key ?? 'active'}>
                <Link
                  to={filter.key ? `/console?status=${filter.key}` : '/console'}
                  className={[styles.filter, current ? styles.filterActive : ''].join(' ')}
                  aria-current={current ? 'page' : undefined}
                >
                  {filter.label}
                  {filter.count !== null && <span className={styles.count}> {filter.count}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {body}
    </div>
  );
}
