import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { BASELINE_RULES } from '../src/policy/baselineRules.js';

/**
 * The demo data, as a pure function.
 *
 * A demo is only evidence if a reviewer can reproduce it (Phase 1 §8). So the
 * data is built here, deterministically, and the script that writes it is a
 * thin wrapper. That split is what lets the data be checked without a database:
 * every document is validated against its real schema, and the policy engine
 * is run over the seeded orders to confirm the demo shows what it claims to.
 *
 * WHAT THE DATA IS FOR. Every order status is represented, so every baseline
 * rule is exercised by a real record. Three orders are set up for specific
 * demonstrations:
 *
 *   1043  paid         the ordinary cancellation: confirm, then executed
 *   1042  packed       dispatched MID-FLIGHT by `npm run seed -- dispatch 1042`,
 *                      to show a confirmation refused at execution (ADR 0003)
 *   1047  paid, £899   caught by a TENANT rule stricter than the baseline
 *                      (ADR 0008) -- escalated rather than confirmable
 *
 * And two orders exist only to be unreachable: another customer's order in the
 * same tenant, and an order in another tenant. Asking to cancel either must
 * produce "does not resolve", identically (ADR 0005).
 *
 * The orders are FAKE. There is no e-commerce integration, and the README says
 * so plainly: cancelling order 1043 is cancelling a seeded record through a
 * real authorisation path.
 */

/** Demo only, and documented as such. Long enough for the registration rule
 *  (MIN_PASSWORD_LENGTH), and named so nobody mistakes it for a real secret. */
export const DEMO_PASSWORD = 'demo-password-change-me';

/**
 * Deterministic ObjectIds from a name.
 *
 * Re-running the seed must not create a second copy of everything, so every
 * document gets the same id on every run. The script upserts by natural key,
 * and a stable id means references between documents stay consistent too.
 */
export function stableId(name) {
  const hex = createHash('sha1').update(`ai-support-desk:${name}`).digest('hex').slice(0, 24);
  return new mongoose.Types.ObjectId(hex);
}

/**
 * Demo accounts with a published password must never reach production.
 *
 * Checked by the script before it connects, and exported so the check itself
 * is tested rather than trusted.
 */
export function assertSafeToSeed(env = process.env) {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to seed demo data into production: it creates accounts with a published password.',
    );
  }
}

const hoursBefore = (now, hours) => new Date(now.getTime() - hours * 3_600_000);

function makeOrder(tenant, customer, orderNumber, status, { item, priceMinor, placedHoursAgo }, now) {
  const shipped = status === 'dispatched' || status === 'delivered';
  return {
    _id: stableId(`order:${tenant.slug}:${orderNumber}`),
    tenantId: tenant._id,
    customerId: customer._id,
    orderNumber,
    status,
    items: [{ sku: `SKU-${orderNumber}`, name: item, qty: 1, unitPriceMinor: priceMinor }],
    currency: 'GBP',
    // Integer minor units, always: this value is a policy condition operand,
    // and a float here would make rule evaluation platform-dependent.
    totalMinor: priceMinor,
    placedAt: hoursBefore(now, placedHoursAgo),
    dispatchedAt: shipped ? hoursBefore(now, placedHoursAgo - 24) : null,
    deliveredAt: status === 'delivered' ? hoursBefore(now, placedHoursAgo - 48) : null,
    cancelledAt: status === 'cancelled' ? hoursBefore(now, placedHoursAgo - 1) : null,
    cancellationRef: status === 'cancelled' ? `cxl-seed-${orderNumber}` : null,
  };
}

export async function buildSeedData({ now = new Date(), hashPassword } = {}) {
  if (typeof hashPassword !== 'function') {
    // Injected, so tests do not pay for a 12-round bcrypt hash and the script
    // uses the real one. There is deliberately no default: a seed that stored a
    // plaintext or weakly hashed password by accident would be worse than one
    // that refuses to run.
    throw new TypeError('buildSeedData requires a hashPassword function');
  }
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const acme = { _id: stableId('tenant:acme'), name: 'Acme Home Goods', slug: 'acme' };
  const globex = { _id: stableId('tenant:globex'), name: 'Globex Outfitters', slug: 'globex' };

  const customer = (tenant, key, displayName, email, externalRef) => ({
    _id: stableId(`customer:${tenant.slug}:${key}`),
    tenantId: tenant._id,
    externalRef,
    displayName,
    email,
    deidentifiedAt: null,
  });

  const ana = customer(acme, 'ana', 'Ana Pereira', 'ana@acme.test', 'ACME-C-001');
  const ben = customer(acme, 'ben', 'Ben Okafor', 'ben@acme.test', 'ACME-C-002');
  const cleo = customer(globex, 'cleo', 'Cleo Martin', 'cleo@globex.test', 'GLOBEX-C-001');

  const user = (tenant, email, name, role, linkedCustomer = null) => ({
    _id: stableId(`user:${tenant.slug}:${email}`),
    tenantId: tenant._id,
    email,
    passwordHash,
    name,
    role,
    customerId: linkedCustomer ? linkedCustomer._id : null,
    status: 'active',
  });

  const users = [
    user(acme, 'admin@acme.test', 'Asha Admin', 'admin'),
    user(acme, 'lead@acme.test', 'Lee Lead', 'lead'),
    user(acme, 'agent@acme.test', 'Aggie Agent', 'agent'),
    user(acme, 'ana@acme.test', 'Ana Pereira', 'customer', ana),
    user(acme, 'ben@acme.test', 'Ben Okafor', 'customer', ben),
    user(globex, 'admin@globex.test', 'Gil Admin', 'admin'),
    user(globex, 'cleo@globex.test', 'Cleo Martin', 'customer', cleo),
  ];

  const orders = [
    makeOrder(acme, ana, '1041', 'placed', { item: 'Linen cushion cover', priceMinor: 2_400, placedHoursAgo: 3 }, now),
    makeOrder(acme, ana, '1042', 'packed', { item: 'Desk lamp', priceMinor: 4_500, placedHoursAgo: 26 }, now),
    makeOrder(acme, ana, '1043', 'paid', { item: 'Wireless keyboard', priceMinor: 12_900, placedHoursAgo: 50 }, now),
    makeOrder(acme, ana, '1044', 'dispatched', { item: 'Ceramic planter', priceMinor: 3_200, placedHoursAgo: 72 }, now),
    makeOrder(acme, ana, '1045', 'delivered', { item: 'Throw blanket', priceMinor: 5_900, placedHoursAgo: 120 }, now),
    makeOrder(acme, ana, '1046', 'cancelled', { item: 'Wall clock', priceMinor: 2_800, placedHoursAgo: 96 }, now),
    makeOrder(acme, ana, '1047', 'paid', { item: 'Oak side table', priceMinor: 89_900, placedHoursAgo: 30 }, now),
    // Unreachable from Ana's conversations, by design.
    makeOrder(acme, ben, '2001', 'paid', { item: 'Bath towels', priceMinor: 3_600, placedHoursAgo: 20 }, now),
    makeOrder(globex, cleo, '3001', 'paid', { item: 'Rain jacket', priceMinor: 7_900, placedHoursAgo: 10 }, now),
  ];

  const baselineRules = BASELINE_RULES.map((rule) => ({
    ...structuredClone(rule),
    _id: stableId(`rule:baseline:${rule.ruleKey}:${rule.version}`),
    tenantId: null,
    createdBy: null,
  }));

  // Stricter than the baseline for one tenant, which the ladder permits and
  // no tenant rule can reverse (ADR 0008).
  const tenantRule = {
    _id: stableId('rule:acme:TENANT-HIGH-VALUE:1'),
    tenantId: acme._id,
    ruleKey: 'TENANT-HIGH-VALUE',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 200,
    conditions: [{ field: 'order.totalMinor', op: 'gt', value: 50_000 }],
    outcome: 'agent-only',
    customerMessage: 'Larger orders are reviewed by a colleague before they are cancelled.',
    internalReason:
      'Acme policy: cancellations over £500 get a human check. Stricter than the platform baseline.',
    createdBy: null,
  };

  const slugOf = (tenantId) => [acme, globex].find((t) => t._id.equals(tenantId)).slug;

  return {
    tenants: [acme, globex],
    customers: [ana, ben, cleo],
    users,
    orders,
    policyRules: [...baselineRules, tenantRule],
    demo: {
      password: DEMO_PASSWORD,
      tenantSlug: 'acme',
      cancellable: '1043',
      dispatchMidFlight: '1042',
      highValue: '1047',
      otherCustomersOrder: '2001',
      otherTenantsOrder: '3001',
      logins: users.map((u) => ({ email: u.email, role: u.role, tenant: slugOf(u.tenantId) })),
    },
  };
}
