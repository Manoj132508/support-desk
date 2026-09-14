import { connectDatabase, disconnectDatabase } from '../src/db/connect.js';
import { hashPassword } from '../src/auth/password.js';
import { config } from '../src/config/env.js';
import { Tenant, User, Customer, Order, PolicyRule } from '../src/db/models/index.js';
import { assertSafeToSeed, buildSeedData } from './seedData.js';

/**
 * npm run seed                    write the demo data (idempotent)
 * npm run seed -- dispatch 1042   mark a pre-dispatch demo order as dispatched
 *
 * NEVER DESTRUCTIVE. Every write is an upsert with `$setOnInsert`, keyed by a
 * natural key, so re-running leaves existing records exactly as they are --
 * including an order a demo has since cancelled. The audit collections are not
 * touched at all; they are append-only, and a seed that tried to reset them
 * would be refused by the model layer anyway.
 *
 * This is a maintenance script, not a request path, so it reads tenants by
 * slug without a session. It never runs against production (assertSafeToSeed).
 *
 * UNVERIFIED without a database: the builder it calls is tested, this wrapper
 * is not.
 */

async function upsert(Model, docs, keyOf) {
  let inserted = 0;
  for (const doc of docs) {
    const result = await Model.updateOne(keyOf(doc), { $setOnInsert: doc }, { upsert: true });
    inserted += result.upsertedCount ?? 0;
  }
  return inserted;
}

async function seed() {
  const data = await buildSeedData({ now: new Date(), hashPassword });

  const inserted = {
    tenants: await upsert(Tenant, data.tenants, (d) => ({ slug: d.slug })),
    customers: await upsert(Customer, data.customers, (d) => ({ _id: d._id })),
    users: await upsert(User, data.users, (d) => ({ tenantId: d.tenantId, email: d.email })),
    orders: await upsert(Order, data.orders, (d) => ({ tenantId: d.tenantId, orderNumber: d.orderNumber })),
    policyRules: await upsert(PolicyRule, data.policyRules, (d) => ({
      tenantId: d.tenantId,
      ruleKey: d.ruleKey,
      version: d.version,
    })),
  };

  console.log(JSON.stringify({ level: 'info', message: 'Seed complete; existing records untouched', inserted }));
  console.log(`\nDemo tenant "${data.demo.tenantSlug}". Every account uses the password "${data.demo.password}".`);
  for (const login of data.demo.logins) console.log(`  ${login.role.padEnd(8)} ${login.email}  (${login.tenant})`);
  console.log(
    `\nTry: sign in as ana@acme.test and ask to cancel order ${data.demo.cancellable}.` +
      `\nFor a refusal at execution, ask to cancel ${data.demo.dispatchMidFlight}, then run` +
      ` "npm run seed -- dispatch ${data.demo.dispatchMidFlight}" before confirming.`,
  );
}

/**
 * Marks a demo order dispatched, as a shipping system would.
 *
 * DELIBERATELY A PLAIN updateOne THAT NEVER TOUCHES __v. That is the exact case
 * the cancellation's write guards against by being conditional on the order's
 * facts rather than only its version (Phase 10 §6): a version-only guard would
 * not notice this change and would cancel a shipped order. The demo reproduces
 * the realistic failure, not a convenient one.
 */
async function dispatch(orderNumber) {
  if (!orderNumber) throw new Error('Usage: npm run seed -- dispatch <orderNumber>');

  const tenant = await Tenant.findOne({ slug: 'acme' }).lean();
  if (!tenant) throw new Error('Run "npm run seed" first: the demo tenant does not exist.');

  const result = await Order.updateOne(
    { tenantId: tenant._id, orderNumber, status: { $in: ['placed', 'paid', 'packed'] } },
    { $set: { status: 'dispatched', dispatchedAt: new Date() } },
  );

  if (result.matchedCount === 0) {
    throw new Error(`Order ${orderNumber} was not found in a pre-dispatch state in the demo tenant.`);
  }
  console.log(JSON.stringify({ level: 'info', message: 'Order marked dispatched', orderNumber }));
}

async function main() {
  assertSafeToSeed(process.env);
  if (!config.mongodbUri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to server/.env and set it.');
  }

  await connectDatabase();
  try {
    const [command = 'seed', argument] = process.argv.slice(2);
    if (command === 'seed') await seed();
    else if (command === 'dispatch') await dispatch(argument);
    else throw new Error(`Unknown command "${command}". Use: seed | dispatch <orderNumber>`);
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'error', message: error.message }));
  process.exit(1);
});
