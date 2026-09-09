export {
  Tenant,
  User,
  Customer,
  Order,
  Conversation,
  Message,
  Ticket,
  ROLES,
  ORDER_STATUS,
} from './core.js';

export {
  PolicyRule,
  ActionProposal,
  ActionOutcome,
  TicketEvent,
  OUTCOMES,
  OUTCOME_LADDER,
  CONDITION_FIELDS,
} from './audit.js';

/** The three append-only collections (INV-B). Exported so a test can assert
 *  each one refuses every write path, rather than each being remembered. */
export const IMMUTABLE_MODELS = ['ActionProposal', 'ActionOutcome', 'TicketEvent'];
