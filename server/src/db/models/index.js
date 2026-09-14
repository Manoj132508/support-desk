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
  PolicyDecision,
  TicketEvent,
  OUTCOMES,
  OUTCOME_LADDER,
  CONDITION_FIELDS,
} from './audit.js';

/** The append-only collections (INV-B). Exported so a test can assert each one
 *  refuses every write path, rather than each being remembered. PolicyDecision
 *  joined the list in Phase 10. */
export const IMMUTABLE_MODELS = ['ActionProposal', 'ActionOutcome', 'TicketEvent', 'PolicyDecision'];
