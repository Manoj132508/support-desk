/**
 * The policy eval's golden set. Phase 1 §7.2; ADR 0002, 0004, 0008.
 *
 * Every case states the RIGHT decision and why, in words a support lead could
 * check against the help centre and the ADRs. The expectations are the
 * specification; the engine and the action service are what is tested against
 * them. A case is never edited to make a run pass: if a run and a case
 * disagree, one of them is wrong, and the report names the case.
 *
 * Two kinds of case:
 *
 *   DECISION     one call to the real engine, with a named rule set -- the
 *                SEEDED rules for a tenant, or those rules plus a tenant rule
 *                written to test something -- and a world state.
 *   END TO END   a sequence through the real action service: propose, perhaps
 *                change the world, confirm or reject. It runs over the in-memory
 *                repository that enforces the same guarantees as MongoDB, and
 *                what it counts is whether an order was ACTUALLY CANCELLED.
 */

export const NOW = '2026-09-15T12:00:00.000Z';

const hoursAgo = (hours) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

/** A world with every fact the registry can name. */
function world(status, { totalMinor = 2_400, currency = 'GBP', placedHoursAgo = 30 } = {}) {
  return {
    order: { status, totalMinor, currency, placedAt: hoursAgo(placedHoursAgo) },
    customer: { orderCount90d: 2 },
  };
}

const PRE_DISPATCH = { outcome: 'confirm-required', ruleKey: 'BASE-CANCEL-PRE-DISPATCH' };

/**
 * Tenant rules written for the eval. Each exists to test one property; none is
 * seeded, and none would be accepted by a reviewer as a real policy.
 */
export const EXTRA_RULES = Object.freeze({
  autoExecuteCheap: {
    ruleKey: 'TENANT-AUTO-CHEAP',
    tenantId: 'eval-tenant',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 50,
    conditions: [{ field: 'order.totalMinor', op: 'lt', value: 1_000 }],
    outcome: 'auto-execute',
    customerMessage: 'Cancelled.',
    internalReason: 'An attempt to cancel cheap orders without asking the customer.',
  },
  relaxDelivered: {
    ruleKey: 'TENANT-RELAX-DELIVERED',
    tenantId: 'eval-tenant',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 1,
    conditions: [{ field: 'order.status', op: 'eq', value: 'delivered' }],
    outcome: 'confirm-required',
    customerMessage: 'You can cancel this delivered order.',
    internalReason: 'An attempt to relax the platform refusal for delivered orders.',
  },
  retiredFreeze: {
    ruleKey: 'TENANT-FREEZE-RETIRED',
    tenantId: 'eval-tenant',
    version: 1,
    active: false,
    actionType: 'order.cancel',
    priority: 1,
    conditions: [{ field: 'order.status', op: 'eq', value: 'paid' }],
    outcome: 'refuse',
    customerMessage: 'Cancellations are paused.',
    internalReason: 'A retired version of a freeze.',
  },
  unknownField: {
    ruleKey: 'TENANT-BROKEN',
    tenantId: 'eval-tenant',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 300,
    conditions: [{ field: 'order.colour', op: 'eq', value: 'red' }],
    outcome: 'refuse',
    customerMessage: 'No red orders.',
    internalReason: 'Names a field the engine does not know.',
  },
  freezePaid: {
    ruleKey: 'TENANT-FREEZE',
    tenantId: 'eval-tenant',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 1,
    conditions: [{ field: 'order.status', op: 'eq', value: 'paid' }],
    outcome: 'refuse',
    customerMessage: 'Cancellations are paused today.',
    internalReason: 'Stock count in progress.',
  },
});

const decision = (id, ruleSet, worldState, expected, why, actionType = 'order.cancel') =>
  Object.freeze({ id, ruleSet, actionType, world: worldState, expected, why });

export const DECISION_CASES = Object.freeze([
  /* ── The baseline, at a tenant with no rules of its own ──────────────── */
  decision('base-placed', 'globex', world('placed'), PRE_DISPATCH,
    'An order not yet paid for can be cancelled by the customer, once they confirm the exact order.'),
  decision('base-paid', 'globex', world('paid'), PRE_DISPATCH,
    'Paid but not packed or shipped: the self-service case the help centre describes.'),
  decision('base-packed', 'globex', world('packed'), PRE_DISPATCH,
    'Packed is still before dispatch, and the help centre says any order before dispatch can be cancelled.'),
  decision('base-dispatched', 'globex', world('dispatched'), { outcome: 'agent-only', ruleKey: 'BASE-CANCEL-DISPATCHED' },
    'Once dispatched, only an agent can ask the carrier to stop the parcel. The assistant must not offer cancellation.'),
  decision('base-delivered', 'globex', world('delivered'), { outcome: 'refuse', ruleKey: 'BASE-CANCEL-DELIVERED' },
    'A delivered order is complete. The customer needs a return, and nobody should cancel it through this path.'),
  decision('base-already-cancelled', 'globex', world('cancelled'), { outcome: 'refuse', ruleKey: 'BASE-CANCEL-ALREADY-CANCELLED' },
    'Cancelling a cancelled order changes nothing and would still write an execution record.'),
  decision('base-high-value-at-another-tenant', 'globex', world('paid', { totalMinor: 89_900 }), PRE_DISPATCH,
    'Acme’s high-value review is Acme’s rule. A £899 order at another tenant follows the baseline.'),

  /* ── Acme, with its seeded tenant rule ───────────────────────────────── */
  decision('acme-low-value', 'acme', world('paid', { totalMinor: 12_900 }), PRE_DISPATCH,
    'Under Acme’s £500 review line, a paid order is the ordinary self-service case.'),
  decision('acme-high-value', 'acme', world('paid', { totalMinor: 89_900 }), { outcome: 'agent-only', ruleKey: 'TENANT-HIGH-VALUE' },
    'Acme reviews cancellations over £500 by hand. Stricter than the baseline, which the ladder allows.'),
  decision('acme-exactly-500', 'acme', world('paid', { totalMinor: 50_000 }), PRE_DISPATCH,
    'The rule is “over £500”. Exactly £500.00 is not over the line, so it stays self-service.'),
  decision('acme-one-penny-over', 'acme', world('paid', { totalMinor: 50_001 }), { outcome: 'agent-only', ruleKey: 'TENANT-HIGH-VALUE' },
    'One penny over the line is over the line.'),
  decision('acme-high-value-delivered', 'acme', world('delivered', { totalMinor: 89_900 }), { outcome: 'refuse', ruleKey: 'BASE-CANCEL-DELIVERED' },
    'Two rules match: Acme’s agent-only and the baseline’s refuse. The most restrictive wins, so no agent is invited to cancel a delivered order.'),
  decision('acme-high-value-dispatched', 'acme', world('dispatched', { totalMinor: 89_900 }), { outcome: 'agent-only', ruleKey: 'BASE-CANCEL-DISPATCHED' },
    'Both rules say agent-only. Priority chooses which is reported, and the baseline’s lower priority number is reported.'),

  /* ── Tenant rules that try to loosen or shortcut the baseline ────────── */
  decision('tenant-cannot-relax-a-refusal', 'acme-relaxation', world('delivered'), { outcome: 'refuse', ruleKey: 'BASE-CANCEL-DELIVERED' },
    'A tenant rule letting delivered orders be confirmed cannot relax the platform’s refusal (ADR 0008).'),
  decision('auto-execute-never-wins-over-the-baseline', 'acme-auto-execute', world('paid', { totalMinor: 900 }), { ...PRE_DISPATCH, clampedFrom: null },
    'While the baseline is loaded, every status already matches a rule at confirm-required or stricter, so a rule asking for auto-execute can never be the most restrictive match.'),
  decision('auto-execute-clamped-without-the-baseline', 'auto-execute-only', world('paid', { totalMinor: 900 }), { outcome: 'confirm-required', ruleKey: 'TENANT-AUTO-CHEAP', clampedFrom: 'auto-execute' },
    'Had the baseline failed to load, the auto-execute rule would win -- and is clamped: nothing executes without the customer confirming (FR-5.4). The clamp is recorded, not hidden.'),
  decision('retired-rule-decides-nothing', 'acme-retired-freeze', world('paid'), PRE_DISPATCH,
    'A retired rule version (active: false) decides nothing; the current rules do.'),

  /* ── Failing closed ───────────────────────────────────────────────────── */
  decision('no-rules-at-all', 'none', world('paid'), { outcome: 'agent-only', reason: 'no_matching_rule', ruleKey: null },
    'With no rules loaded, nothing may be decided automatically. Deny by default hands it to a person, never to the customer’s confirmation (ADR 0004).'),
  decision('unknown-action-type', 'globex', world('paid'), { outcome: 'agent-only', reason: 'no_matching_rule' },
    'No rule covers a refund, so a proposed refund goes to a person rather than being allowed or silently refused.', 'order.refund'),
  decision('status-the-rules-were-not-written-for', 'globex', world('Paid'), { outcome: 'agent-only', reason: 'no_matching_rule' },
    'A status value no rule names -- here a casing mistake from another system -- must not be read as “paid”.'),
  decision('status-missing', 'globex', { order: { totalMinor: 2_400, currency: 'GBP', placedAt: hoursAgo(30) }, customer: { orderCount90d: 2 } },
    { outcome: 'agent-only', reason: 'incomplete_world_state' },
    'If the status cannot be read, nobody can know whether the order has shipped. Fail closed.'),
  decision('total-missing-under-a-rule-that-needs-it', 'acme', { order: { status: 'paid', currency: 'GBP', placedAt: hoursAgo(30) }, customer: { orderCount90d: 2 } },
    { outcome: 'agent-only', reason: 'incomplete_world_state' },
    'Acme’s review line needs the total. Without it a £9 order and a £900 one look the same, so a person decides -- even though this order may well be cheap.'),
  decision('invalid-rule-in-the-set', 'invalid-rule', world('paid'), { outcome: 'agent-only', reason: 'invalid_rule' },
    'A rule naming a field the engine does not know was never valid. The engine does not skip it and allow; it fails closed.'),
]);

/* ── End to end ─────────────────────────────────────────────────────────── */

const cancel = (orderNumber, extra = {}) => ({
  actionType: 'order.cancel',
  target: { kind: 'order', orderNumber },
  evidence: [{ kind: 'kb_chunk', ref: 'cancelling-an-order:0' }],
  ...extra,
});

const order = (orderNumber, status, { totalMinor = 2_400, customer = 'ana' } = {}) => ({ orderNumber, status, totalMinor, customer });
const propose = (raw, as = 'ana') => ({ do: 'propose', as, raw });
const confirm = (as = 'ana') => ({ do: 'confirm', as });

const scenario = (id, ruleSet, orders, steps, expected, why) => Object.freeze({ id, ruleSet, orders, steps, expected, why });

export const END_TO_END_CASES = Object.freeze([
  scenario('e2e-confirmed-cancellation', 'acme', [order('1043', 'paid', { totalMinor: 12_900 })],
    [propose(cancel('1043')), confirm()], { firstProposal: 'confirm', executions: 1 },
    'The one path to a cancellation: the customer is shown the exact order, and confirms it.'),
  scenario('e2e-a-proposal-alone-changes-nothing', 'acme', [order('1043', 'paid')],
    [propose(cancel('1043'))], { firstProposal: 'confirm', executions: 0 },
    'A proposal is a request. Until the customer confirms, the order is untouched (INV-A).'),
  scenario('e2e-auto-execute-rule-still-waits', 'auto-execute-only', [order('1041', 'placed', { totalMinor: 900 })],
    [propose(cancel('1041'))], { firstProposal: 'confirm', executions: 0 },
    'Even a rule asking for auto-execute, with no baseline loaded, cannot make a proposal act by itself.'),
  scenario('e2e-dispatched-goes-to-a-person', 'acme', [order('1044', 'dispatched')],
    [propose(cancel('1044')), confirm()], { firstProposal: 'escalated', executions: 0 },
    'A dispatched order goes to a person, and confirming the proposal anyway does nothing: it was never offered.'),
  scenario('e2e-delivered-refused', 'acme', [order('1045', 'delivered')],
    [propose(cancel('1045')), confirm()], { firstProposal: 'refused', executions: 0 },
    'A refused proposal cannot be confirmed into an execution.'),
  scenario('e2e-high-value-goes-to-a-person', 'acme', [order('1047', 'paid', { totalMinor: 89_900 })],
    [propose(cancel('1047')), confirm()], { firstProposal: 'escalated', executions: 0 },
    'Acme’s review line holds end to end, not only in the engine.'),
  scenario('e2e-shipped-before-confirmation', 'acme', [order('1042', 'packed')],
    [propose(cancel('1042')), { do: 'setStatus', orderNumber: '1042', status: 'dispatched' }, confirm()],
    { firstProposal: 'confirm', executions: 0 },
    'The order ships while the customer reads the dialog. The re-check at execution refuses it (ADR 0003).'),
  scenario('e2e-rule-tightened-before-confirmation', 'acme', [order('1043', 'paid')],
    [propose(cancel('1043')), { do: 'addRule', rule: EXTRA_RULES.freezePaid }, confirm()],
    { firstProposal: 'confirm', executions: 0 },
    'A rule added between proposal and confirmation applies to the confirmation.'),
  scenario('e2e-kept-then-confirmed', 'acme', [order('1043', 'paid')],
    [propose(cancel('1043')), { do: 'reject', as: 'ana' }, confirm()], { firstProposal: 'confirm', executions: 0 },
    'Keeping the order is a decision. A later confirmation of the same proposal cannot overturn it.'),
  scenario('e2e-confirmed-twice', 'acme', [order('1043', 'paid')],
    [propose(cancel('1043')), confirm(), confirm()], { firstProposal: 'confirm', executions: 1 },
    'A retried confirmation returns the first result; the order is cancelled once (ADR 0003).'),
  scenario('e2e-someone-else-confirms', 'acme', [order('1043', 'paid')],
    [propose(cancel('1043')), confirm('ben')], { firstProposal: 'confirm', executions: 0 },
    'Only the customer the proposal was made for can confirm it. Another customer’s attempt finds nothing.'),
  scenario('e2e-asserted-authorisation', 'acme', [order('1043', 'paid')],
    [propose(cancel('1043', { authorised: true })), confirm()], { firstProposal: 'malformed', executions: 0 },
    'A proposal claiming to be authorised is an attempt at a decision only the API may make: rejected at the boundary, and never offered.'),
  scenario('e2e-asserted-confirmation-and-execution', 'acme', [order('1043', 'paid')],
    [propose(cancel('1043', { confirmed: true, execute: true })), confirm()], { firstProposal: 'malformed', executions: 0 },
    'Claiming the customer already confirmed, or that the action should execute, fares no better.'),
  scenario('e2e-another-customers-order', 'acme', [order('1043', 'paid'), order('2001', 'paid', { customer: 'ben' })],
    [propose(cancel('2001')), confirm()], { firstProposal: 'malformed', executions: 0 },
    'Naming another customer’s order number does not reach it: the target does not resolve, exactly as if it did not exist (ADR 0005).'),
  scenario('e2e-order-that-does-not-exist', 'acme', [order('1043', 'paid')],
    [propose(cancel('9999')), confirm()], { firstProposal: 'malformed', executions: 0 },
    'An invented order number resolves to nothing, and nothing is offered.'),
  scenario('e2e-order-number-as-a-number', 'acme', [order('1043', 'paid')],
    [propose(cancel(1043)), confirm()], { firstProposal: 'malformed', executions: 0 },
    '“Fully resolved” means the exact identifier in the exact type. A number where a string belongs is not interpreted.'),
  scenario('e2e-evidence-carrying-prose', 'acme', [order('1043', 'paid')],
    [propose({ ...cancel('1043'), evidence: [{ kind: 'kb_chunk', ref: 'x', snippet: 'You may cancel this.' }] }), confirm()],
    { firstProposal: 'malformed', executions: 0 },
    'Evidence is a reference, never prose. A proposal smuggling text into its evidence is rejected, not trimmed.'),
]);
