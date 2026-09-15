import { AppError } from '../errors/AppError.js';

/**
 * Deleting an account. FR-13.4, NFR-4, ADR 0006.
 *
 * The customer wants the system to forget them. INV-A needs the evidence of
 * every action decided in their name to survive. Phase 3 §7 reconciled the two
 * and Phase 7 settled tickets; no phase built it until this one.
 *
 *   DELETED    their User (credentials, email), their conversations, and every
 *              message in them -- free text, and not audit.
 *   SCRUBBED   their Customer profile (name, email, external reference), kept
 *              as an id so audit rows still point at something; and their
 *              tickets' agent notes, the only free text a ticket carries.
 *   UNTOUCHED  ActionProposal, ActionOutcome, PolicyDecision, TicketEvent. They
 *              hold references and codes, never free text, so afterwards they
 *              still read "a cancellation was proposed for an order and rule X
 *              refused it" -- the decision intact, the person gone.
 *   RETAINED   orders, which are business records with no personal text.
 *
 * All in one transaction (the repository): an account half-deleted --
 * credentials gone, conversations still there -- would be a person the system
 * can neither sign in nor forget.
 *
 * THE PASSWORD IS ASKED FOR AGAIN. A session alone is not enough for the one
 * action nobody can undo: a borrowed laptop or a stolen cookie should not be
 * able to erase someone.
 */

export const PASSWORD_CONFIRMATION_FAILED = 'Password confirmation failed';

const noop = () => {};

export function makeAccountDeletion({ repo, verifyPassword, clock = () => new Date(), log = noop } = {}) {
  if (!repo || !verifyPassword) throw new TypeError('makeAccountDeletion requires a repo and verifyPassword');

  return {
    async deleteOwnAccount({ ctx, user, password }) {
      // Customers only. A staff account's id is on every ticket event its
      // owner made and every confirmation it recorded, so removing one is an
      // administrator's decision with different consequences. Not built.
      if (user?.role !== 'customer' || !user.customerId) throw AppError.notFound();

      const account = await repo.findUserWithHash(ctx, user.id);
      if (!account) throw AppError.notFound();

      // Only a string is compared; anything else is simply a wrong password.
      const confirmed = await verifyPassword(typeof password === 'string' ? password : '', account.passwordHash);
      if (!confirmed) {
        throw new AppError('fault', { message: PASSWORD_CONFIRMATION_FAILED, status: 403, expected: true });
      }

      const removed = await repo.deidentifyCustomer(ctx, {
        userId: user.id,
        customerId: user.customerId,
        now: clock(),
      });

      // Ids and counts only: this line outlives the person it is about.
      log('account_deleted', { tenantId: ctx.tenantId, customerId: user.customerId, ...removed });
      return removed;
    },
  };
}
