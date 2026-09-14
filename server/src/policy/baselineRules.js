/**
 * The platform baseline. ADR 0008.
 *
 * `tenantId: null`, version-controlled HERE, and seeded -- never created
 * through the admin UI. That is the point of keeping them in a source file: a
 * change to a platform guarantee is a reviewed commit, and the policy eval runs
 * against exactly these rules in CI.
 *
 * Because the engine takes the MOST RESTRICTIVE match (see engine.js), a tenant
 * rule can make any of these stricter but can never relax one. That property
 * comes from the ladder, not from anything special about this file -- which is
 * why these rules are ordinary rules and the engine has no branch for them.
 *
 * COVERAGE IS DELIBERATE AND COMPLETE. Every order status maps to exactly one
 * baseline outcome:
 *
 *   placed · paid · packed   ->  confirm-required   the self-service case
 *   dispatched               ->  agent-only         a human may; the assistant may not
 *   delivered · cancelled    ->  refuse             nobody may, through this path
 *
 * Deny-by-default would catch a status missing from this list, safely -- but a
 * baseline that relied on the default for an ordinary status would escalate
 * every such conversation for no reason anyone wrote down. A test asserts no
 * status falls through.
 *
 * WHAT THE VOCABULARY CANNOT EXPRESS, stated rather than hidden. The help
 * centre says personalised items cannot be cancelled after the first hour.
 * There is no `item.personalised` field in the condition registry, so that rule
 * is not here. Adding it is a registry change (a new field, a resolver, a
 * test), which is the intended cost of a closed vocabulary -- the alternative is
 * a free-form expression language nobody can reason about exhaustively.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export const BASELINE_RULES = deepFreeze([
  {
    ruleKey: 'BASE-CANCEL-DELIVERED',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 10,
    conditions: [{ field: 'order.status', op: 'eq', value: 'delivered' }],
    outcome: 'refuse',
    customerMessage:
      "This order has already been delivered, so it can't be cancelled. You can return it instead.",
    internalReason:
      'Delivery completes an order. What the customer needs is a return, not a cancellation.',
  },
  {
    ruleKey: 'BASE-CANCEL-ALREADY-CANCELLED',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 10,
    conditions: [{ field: 'order.status', op: 'eq', value: 'cancelled' }],
    outcome: 'refuse',
    customerMessage: 'This order has already been cancelled, so there is nothing more to do.',
    internalReason:
      'Cancelling a cancelled order changes nothing but would still write an execution record.',
  },
  {
    ruleKey: 'BASE-CANCEL-DISPATCHED',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 20,
    conditions: [{ field: 'order.status', op: 'eq', value: 'dispatched' }],
    // agent-only, not refuse. After dispatch an agent can still ask the carrier
    // to intercept the parcel; the assistant cannot. This is the distinction the
    // Phase 3 amendment added a fourth outcome for -- "a human may" and "nobody
    // may" give the agent console opposite affordances.
    outcome: 'agent-only',
    customerMessage:
      "This order has already been dispatched, so I can't cancel it myself. I'll bring in a colleague who can check whether the carrier can stop it.",
    internalReason:
      'Post-dispatch cancellation needs a carrier interception request, which only an agent can raise.',
  },
  {
    ruleKey: 'BASE-CANCEL-PRE-DISPATCH',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 100,
    conditions: [{ field: 'order.status', op: 'in', value: ['placed', 'paid', 'packed'] }],
    // confirm-required, never auto-execute (FR-5.4). The customer confirms the
    // exact resolved action in ADR 0009's dialog before anything changes.
    outcome: 'confirm-required',
    customerMessage: 'This order can still be cancelled. Please confirm to go ahead.',
    internalReason:
      'Pre-dispatch cancellation is the self-service case: the customer confirms, the assistant never acts alone.',
  },
]);
