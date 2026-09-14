import { idempotencyKeyFor } from './actionService.js';

/**
 * The sweep that expires proposals nobody decided. ADR 0009 property 5.
 *
 * A customer can dismiss the confirmation dialog and walk away. The proposal is
 * then pending forever: no outcome row, nothing authorised. This job gives it a
 * terminal outcome, `expired` -- a non-execution, like every other outcome
 * except `executed`.
 *
 * THE TTL IS HYGIENE, NOT SAFETY. ADR 0003 considered a proposal TTL as the
 * protection against acting on stale facts, and rejected it: a TTL narrows the
 * window, it never closes it. What makes a late confirmation safe is the
 * execution-time re-check, which runs whether a proposal is thirty seconds old
 * or thirty minutes old. This sweep only keeps the audit tidy and stops a
 * forgotten dialog being confirmable days later.
 *
 * TENANT BY TENANT. A system job has no session and therefore no tenant, and
 * the tempting implementation is one query over every tenant's proposals. That
 * would be a second deliberate cross-tenant business query, after the policy
 * loader ADR 0008 names as the only one. Instead the sweep lists tenants -- a
 * table that is not tenant-scoped by nature -- and does every business read and
 * write inside one tenant's scope, exactly like a request would.
 *
 * RACING A CONFIRMATION. A customer may confirm at the same moment the sweep
 * expires the same proposal. The idempotency key's unique index decides: which
 * ever outcome is recorded first stands, and the other writer is told the
 * proposal was already decided. The sweep never overwrites anything.
 */

export const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_BATCH_PER_TENANT = 100;

const noop = () => {};

export function makeExpirySweep({
  repo,
  clock = () => new Date(),
  log = noop,
  ttlMs = DEFAULT_PENDING_TTL_MS,
  batchPerTenant = DEFAULT_BATCH_PER_TENANT,
} = {}) {
  if (!repo) throw new TypeError('makeExpirySweep requires a repo');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive number');

  async function sweep() {
    const cutoff = new Date(clock().getTime() - ttlMs);
    const report = { tenants: 0, examined: 0, expired: 0, alreadyDecided: 0, neverOffered: 0 };

    for (const tenantId of await repo.listTenantIds()) {
      const ctx = { tenantId: String(tenantId) };
      report.tenants += 1;

      const pending = await repo.findPendingProposals(ctx, { olderThan: cutoff, limit: batchPerTenant });

      for (const proposal of pending) {
        report.examined += 1;

        // Only a proposal that was OFFERED can expire. A resolved proposal with
        // no confirm-required decision was never shown to the customer -- the
        // process may have stopped between recording it and deciding on it --
        // and expiring it would record a customer inaction that never happened.
        const decisionAtProposal = await repo.findDecision(ctx, proposal._id, 'proposal');
        if (!decisionAtProposal || decisionAtProposal.outcome !== 'confirm-required') {
          report.neverOffered += 1;
          log('expiry_skipped_never_offered', { proposalId: String(proposal._id), tenantId: ctx.tenantId });
          continue;
        }

        const { duplicate } = await repo.recordOutcome(ctx, {
          proposalId: proposal._id,
          outcome: 'expired',
          decisionAtProposal,
          decisionAtExecution: null,
          idempotencyKey: idempotencyKeyFor(proposal._id),
        });

        if (duplicate) report.alreadyDecided += 1;
        else report.expired += 1;
      }
    }

    log('expiry_sweep_complete', report);
    return report;
  }

  return { sweep };
}
