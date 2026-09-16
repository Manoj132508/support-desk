import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/db/connect.js';
import {
  ActionOutcome,
  ActionProposal,
  Conversation,
  Customer,
  Message,
  Order,
  PolicyDecision,
  PolicyRule,
  Tenant,
  Ticket,
  TicketEvent,
  User,
} from '../src/db/models/index.js';
import { buildAttemptPipeline } from '../src/policy/mongoAuditRepo.js';
import { pendingProposalsPipeline } from '../src/policy/mongoSweepRepo.js';
import { HISTORY_READ_LIMIT } from '../src/services/turnPayload.js';

/**
 * Are the hot queries using the indexes they were designed for? Phase 14.
 *
 *   node --env-file=.env.perf perf/queryPlans.js                       the report
 *   node --env-file=.env.perf perf/queryPlans.js --synthetic-tenants 200
 *
 * Asks MongoDB to EXPLAIN each query the request paths run, in the shape the
 * code runs it, and reports the index chosen, the keys and documents examined
 * against the documents returned, and any stage that means work growing with
 * the collection: a collection scan, or a sort done in memory.
 *
 * Phase 3 declared the indexes and Phase 7 asserted the declarations. Neither
 * could say whether the planner USES them, which needs a real server. Plan
 * shape mostly does not depend on data volume, but "documents examined" does:
 * with two tenants, a query reading every tenant's rows looks identical to one
 * reading only its own. `--synthetic-tenants` adds other tenants' rules to a
 * perf database -- and refuses any other -- so that difference shows.
 */

const PERF_DATABASE_SUFFIX = '-perf';

// Plans the optimiser considered and did not choose. Their stages describe work
// that never ran, and reading them reported sorts in memory that did not happen.
const NOT_RUN = new Set(['rejectedPlans', 'allPlansExecution']);

function walk(node, visit) {
  if (Array.isArray(node)) node.forEach((item) => walk(item, visit));
  else if (node && typeof node === 'object') {
    visit(node);
    for (const [key, value] of Object.entries(node)) {
      if (!NOT_RUN.has(key)) walk(value, visit);
    }
  }
}

/** The facts worth reading from an explain document, whatever its engine's layout. */
export function readPlan(explain) {
  const stages = new Set();
  const indexes = new Set();
  let keys = null;
  let docs = null;
  let returned = null;
  const lookups = [];

  walk(explain, (node) => {
    if (typeof node.stage === 'string') stages.add(node.stage);
    if (typeof node.indexName === 'string') indexes.add(node.indexName);
    if (node.executionStats && keys === null) {
      keys = node.executionStats.totalKeysExamined ?? null;
      docs = node.executionStats.totalDocsExamined ?? null;
      returned = node.executionStats.nReturned ?? null;
    }
    if (node.$lookup && (node.collectionScans !== undefined || node.indexesUsed !== undefined)) {
      lookups.push({ from: node.$lookup.from, collectionScans: node.collectionScans ?? 0, indexesUsed: node.indexesUsed ?? [] });
    }
  });
  // An aggregate's totals can sit beside its first stage rather than inside it.
  if (keys === null) {
    walk(explain, (node) => {
      if (keys === null && typeof node.totalKeysExamined === 'number') {
        keys = node.totalKeysExamined;
        docs = node.totalDocsExamined ?? null;
        returned = node.nReturned ?? null;
      }
    });
  }

  const concerns = [];
  if (stages.has('COLLSCAN')) concerns.push('collection scan');
  if (stages.has('SORT')) concerns.push('sort in memory');
  if (docs !== null && returned !== null && docs > returned) concerns.push(`examined ${docs} documents to return ${returned}`);
  for (const lookup of lookups) {
    if (lookup.collectionScans > 0) concerns.push(`$lookup into ${lookup.from} scans the collection`);
  }
  return { stages: [...stages], indexes: [...indexes], keys, docs, returned, lookups, concerns };
}

async function explainFind(query) {
  return readPlan(await query.explain('executionStats'));
}

async function explainAggregate(Model, pipeline) {
  // As a raw command: the driver refuses `aggregate(...).explain()` on a
  // connection whose write concern is set, and this application sets majority
  // on every connection (db/connect.js).
  const explain = await mongoose.connection.db.command({
    explain: { aggregate: Model.collection.name, pipeline, cursor: {} },
    verbosity: 'executionStats',
  });
  return readPlan(explain);
}

async function addSyntheticTenants(count) {
  const name = mongoose.connection.db.databaseName;
  if (!name.endsWith(PERF_DATABASE_SUFFIX)) {
    throw new Error(`Refusing to add synthetic data to "${name}": only a database ending in "${PERF_DATABASE_SUFFIX}".`);
  }
  const existing = await Tenant.countDocuments({ slug: /^perf-tenant-/ });
  for (let index = existing; index < count; index += 1) {
    const tenant = await Tenant.create({ name: `Perf tenant ${index}`, slug: `perf-tenant-${index}` });
    await PolicyRule.insertMany(
      [100, 200, 300].map((priority, rule) => ({
        tenantId: tenant._id,
        ruleKey: `PERF-${rule}`,
        version: 1,
        active: true,
        actionType: 'order.cancel',
        priority,
        conditions: [{ field: 'order.totalMinor', op: 'gt', value: 10_000 * (rule + 1) }],
        outcome: 'agent-only',
        customerMessage: 'A colleague will review this.',
        internalReason: 'Synthetic tenant rule for the Phase 14 query plan check.',
        createdBy: null,
      })),
    );
  }
  return Math.max(count - existing, 0);
}

export async function checkQueryPlans({ syntheticTenants = 0 } = {}) {
  const added = syntheticTenants ? await addSyntheticTenants(syntheticTenants) : 0;

  const tenant = await Tenant.findOne({ slug: 'acme' }).lean();
  if (!tenant) throw new Error('No "acme" tenant: seed this database first.');
  const tenantId = tenant._id;
  const ctx = { tenantId: String(tenantId) };
  const user = await User.findOne({ tenantId, email: 'ana@acme.test' }).lean();
  const customer = await Customer.findOne({ _id: user.customerId }).lean();
  const conversation = (await Conversation.findOne({ tenantId, customerId: customer._id }).sort({ _id: -1 }).lean()) ?? { _id: new mongoose.Types.ObjectId() };
  const proposal = (await ActionProposal.findOne({ tenantId }).sort({ _id: -1 }).lean()) ?? { _id: new mongoose.Types.ObjectId() };
  const ticketId = (await Ticket.findOne({ tenantId }).lean())?._id ?? new mongoose.Types.ObjectId();
  const since = new Date(Date.now() - 90 * 24 * 3_600_000);

  const checks = [
    ['every request: authenticate', () => explainFind(User.findById(user._id))],
    ['sign-in: tenant by slug', () => explainFind(Tenant.findOne({ slug: 'acme' }))],
    ['sign-in: user in tenant', () => explainFind(User.findOne({ tenantId, email: 'ana@acme.test' }))],
    ['turn: conversation', () => explainFind(Conversation.findOne({ _id: conversation._id, tenantId }))],
    ['turn: history window', () => explainFind(Message.find({ tenantId, conversationId: conversation._id }).sort({ createdAt: -1 }).limit(HISTORY_READ_LIMIT))],
    ['transcript', () => explainFind(Message.find({ tenantId, conversationId: conversation._id }).sort({ createdAt: 1 }))],
    ['propose: rules for tenant + baseline', () => explainFind(PolicyRule.find({ actionType: 'order.cancel', active: true, tenantId: { $in: [tenantId, null] } }))],
    ['propose: order by number', () => explainFind(Order.findOne({ tenantId, customerId: customer._id, orderNumber: '1043' }))],
    ['propose: orders in 90 days', () => explainFind(Order.find({ tenantId, customerId: customer._id, placedAt: { $gte: since } }))],
    ['confirm: outcome by idempotency key', () => explainFind(ActionOutcome.findOne({ tenantId, idempotencyKey: `proposal:${proposal._id}` }))],
    ['confirm: proposal-time decision', () => explainFind(PolicyDecision.findOne({ tenantId, proposalId: proposal._id, stage: 'proposal' }))],
    ['console: queue, active', () => explainFind(Ticket.find({ tenantId, active: true }).sort({ openedAt: 1, _id: 1 }).limit(26))],
    ['console: queue, one status', () => explainFind(Ticket.find({ tenantId, currentStatus: 'open' }).sort({ openedAt: 1, _id: 1 }).limit(26))],
    ['console: ticket events', () => explainFind(TicketEvent.find({ tenantId, ticketId }).sort({ seq: 1 }))],
    ['console: conversation proposals', () => explainFind(ActionProposal.find({ tenantId, conversationId: conversation._id }))],
    ['audit: newest attempts', () => explainAggregate(ActionProposal, buildAttemptPipeline(ctx, { limit: 25 }, { outcomes: ActionOutcome.collection.name, decisions: PolicyDecision.collection.name }))],
    ['sweep: pending proposals', () => explainAggregate(ActionProposal, pendingProposalsPipeline(ctx, { olderThan: new Date(), limit: 100 }, { outcomes: ActionOutcome.collection.name }))],
  ];

  const rows = [];
  for (const [name, run] of checks) rows.push({ name, ...(await run()) });
  return { database: mongoose.connection.db.databaseName, syntheticTenantsAdded: added, rows };
}

function printReport(result) {
  const line = '='.repeat(100);
  console.log(`\n${line}\n  QUERY PLANS -- ${result.database}${result.syntheticTenantsAdded ? ` (+${result.syntheticTenantsAdded} synthetic tenants)` : ''}\n${line}`);
  for (const row of result.rows) {
    const counts = `keys ${row.keys ?? '-'} / docs ${row.docs ?? '-'} / returned ${row.returned ?? '-'}`;
    console.log(`  ${row.concerns.length ? '!!' : 'ok'}  ${row.name.padEnd(38)} ${(row.indexes.join(', ') || row.stages.join(',')).slice(0, 44).padEnd(45)} ${counts}`);
    for (const concern of row.concerns) console.log(`        -> ${concern}`);
  }
  console.log(`${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--synthetic-tenants');
  await connectDatabase();
  try {
    const result = await checkQueryPlans({ syntheticTenants: index > -1 ? Number(process.argv[index + 1]) : 0 });
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
  } finally {
    await disconnectDatabase();
  }
}
