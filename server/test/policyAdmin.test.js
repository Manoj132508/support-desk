import test from 'node:test';
import assert from 'node:assert/strict';
import { makePolicyAdmin, validateRuleDefinition, RuleConflictError } from '../src/policy/policyAdmin.js';
import { BASELINE_RULES } from '../src/policy/baselineRules.js';
import { evaluate } from '../src/policy/engine.js';
import { PolicyRule } from '../src/db/models/index.js';

/**
 * Policy administration: the only way a person changes what the assistant may
 * do. Every change is a new version, the baseline cannot be relaxed through the
 * API, and a rule that would behave unlike how it reads is refused when written.
 */

const CTX = { tenantId: 't1' };
const ADMIN = 'admin-1';

const baselineRows = () =>
  BASELINE_RULES.map((rule, index) => ({
    ...structuredClone(rule),
    _id: `base-${index}`,
    tenantId: null,
  }));

function tenantRule(overrides = {}) {
  return {
    _id: 'tenant-rule-1',
    tenantId: 't1',
    ruleKey: 'TENANT-HIGH-VALUE',
    version: 1,
    active: true,
    actionType: 'order.cancel',
    priority: 200,
    conditions: [{ field: 'order.totalMinor', op: 'gt', value: 50_000 }],
    outcome: 'agent-only',
    customerMessage: 'Larger orders are reviewed by a colleague before they are cancelled.',
    internalReason: 'High-value cancellations get a human check.',
    ...overrides,
  };
}

function makeFakePolicyRepo(rows) {
  const state = { rows: structuredClone(rows) };
  let counter = 0;
  const visible = (ctx, row) => row.tenantId === null || row.tenantId === ctx.tenantId;
  const clone = (value) => (value ? structuredClone(value) : null);

  return {
    state,
    async listRules(ctx) {
      return state.rows.filter((row) => visible(ctx, row)).map((row) => structuredClone(row));
    },
    async findRuleById(ctx, id) {
      return clone(state.rows.find((row) => row._id === id && visible(ctx, row)));
    },
    async findLatestVersion(ctx, ruleKey) {
      const versions = state.rows
        .filter((row) => row.tenantId === ctx.tenantId && row.ruleKey === ruleKey)
        .sort((a, b) => b.version - a.version);
      return clone(versions[0]);
    },
    async insertVersion(ctx, { next }) {
      const taken = state.rows.some(
        (row) => row.tenantId === next.tenantId && row.ruleKey === next.ruleKey && row.version === next.version,
      );
      if (taken) throw new RuleConflictError();
      for (const row of state.rows) {
        if (row.tenantId === next.tenantId && row.ruleKey === next.ruleKey) row.active = false;
      }
      const inserted = { _id: `rule-v-${++counter}`, createdAt: new Date('2026-09-14T12:00:00Z'), ...structuredClone(next) };
      state.rows.push(inserted);
      return structuredClone(inserted);
    },
    async insertRule(ctx, definition) {
      if (state.rows.some((row) => row.tenantId === definition.tenantId && row.ruleKey === definition.ruleKey)) {
        throw new RuleConflictError();
      }
      const inserted = { _id: `rule-new-${++counter}`, createdAt: new Date('2026-09-14T12:00:00Z'), ...structuredClone(definition) };
      state.rows.push(inserted);
      return structuredClone(inserted);
    },
  };
}

function setup(extraRows = [tenantRule()]) {
  const repo = makeFakePolicyRepo([...baselineRows(), ...extraRows]);
  return { repo, admin: makePolicyAdmin({ repo }) };
}

async function rejects(promise, status, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status, `expected ${status}, got ${error.status}: ${error.message}`);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

/* ── Listing ──────────────────────────────────────────────────────────── */

test('ADR 0008: rules are listed split into baseline and tenant, and only the baseline is locked', async () => {
  const { admin } = setup();
  const { baseline, tenant, tenantHasOwnRules } = await admin.listPolicies(CTX);

  assert.equal(baseline.length, BASELINE_RULES.length);
  assert.ok(baseline.every((rule) => rule.scope === 'baseline' && rule.editable === false));
  assert.deepEqual(tenant.map((rule) => rule.ruleKey), ['TENANT-HIGH-VALUE']);
  assert.equal(tenant[0].editable, true);
  assert.equal(tenantHasOwnRules, true);
});

test('only the latest version of each rule is listed, including a disabled one', async () => {
  const { admin } = setup([
    tenantRule({ _id: 'v1', version: 1, active: false }),
    tenantRule({ _id: 'v2', version: 2, active: false, outcome: 'refuse' }),
  ]);
  const { tenant } = await admin.listPolicies(CTX);
  assert.equal(tenant.length, 1);
  assert.equal(tenant[0].version, 2);
  assert.equal(tenant[0].active, false, 'a disabled rule is still shown, so it can be re-enabled');
});

test('ADR 0008: a tenant with no rules of its own is stated, not shown as an empty table', async () => {
  const { admin } = setup([]);
  const { tenant, tenantHasOwnRules, baseline } = await admin.listPolicies(CTX);
  assert.deepEqual(tenant, []);
  assert.equal(tenantHasOwnRules, false);
  assert.ok(baseline.length > 0, 'the baseline still applies');
});

test('INV-D: another tenant’s rules never appear, even if the repo leaked one', async () => {
  const { repo, admin } = setup();
  const leaky = { ...repo, listRules: async () => [...(await repo.listRules(CTX)), tenantRule({ _id: 'x', tenantId: 't2', ruleKey: 'OTHER-TENANT-RULE' })] };
  const { tenant } = await makePolicyAdmin({ repo: leaky }).listPolicies(CTX);
  assert.ok(!tenant.some((rule) => rule.ruleKey === 'OTHER-TENANT-RULE'));
});

/* ── Editing ──────────────────────────────────────────────────────────── */

test('FR-12.2: an edit writes the NEXT VERSION and leaves the old one intact', async () => {
  const { repo, admin } = setup();
  const updated = await admin.updatePolicy(CTX, {
    ruleId: 'tenant-rule-1',
    changes: { outcome: 'refuse' },
    userId: ADMIN,
  });

  assert.equal(updated.version, 2);
  assert.equal(updated.outcome, 'refuse');
  assert.equal(updated.active, true);
  assert.equal(updated.createdBy, ADMIN);

  const v1 = repo.state.rows.find((row) => row._id === 'tenant-rule-1');
  assert.equal(v1.outcome, 'agent-only', 'history is never rewritten — a past decision stays explainable');
  assert.equal(v1.active, false, 'only the bookkeeping flag changes on the old version');
});

test('disabling a rule is itself a version, so it is audited', async () => {
  const { repo, admin } = setup();
  const disabled = await admin.updatePolicy(CTX, { ruleId: 'tenant-rule-1', changes: { active: false }, userId: ADMIN });
  assert.equal(disabled.version, 2);
  assert.equal(disabled.active, false);
  assert.equal(repo.state.rows.filter((row) => row.ruleKey === 'TENANT-HIGH-VALUE' && row.active).length, 0);
});

test('rewording a disabled rule does not quietly switch it back on', async () => {
  const { admin } = setup([tenantRule({ active: false })]);
  const reworded = await admin.updatePolicy(CTX, {
    ruleId: 'tenant-rule-1',
    changes: { customerMessage: 'Larger orders get a quick review first.' },
    userId: ADMIN,
  });
  assert.equal(reworded.active, false);
});

test('ADR 0008: a baseline rule cannot be edited through the API', async () => {
  const { admin } = setup();
  await rejects(
    admin.updatePolicy(CTX, { ruleId: 'base-0', changes: { outcome: 'confirm-required' }, userId: ADMIN }),
    403,
    /Baseline rules are managed by the platform/,
  );
});

test('INV-D: an unknown or foreign rule id is a 404', async () => {
  const { admin } = setup([tenantRule(), tenantRule({ _id: 'foreign', tenantId: 't2' })]);
  await rejects(admin.updatePolicy(CTX, { ruleId: 'nope', changes: { priority: 1 }, userId: ADMIN }), 404);
  await rejects(admin.updatePolicy(CTX, { ruleId: 'foreign', changes: { priority: 1 }, userId: ADMIN }), 404);
});

test('editing from an out-of-date screen is refused rather than overwriting a newer version', async () => {
  const { admin } = setup([tenantRule({ _id: 'v1', version: 1, active: false }), tenantRule({ _id: 'v2', version: 2 })]);
  await rejects(
    admin.updatePolicy(CTX, { ruleId: 'v1', changes: { priority: 5 }, userId: ADMIN }),
    409,
    /newer version \(v2\)/,
  );
});

test('two editors racing: the unique version settles it, and the loser is told', async () => {
  const { repo, admin } = setup();
  const staleView = structuredClone(repo.state.rows.find((row) => row._id === 'tenant-rule-1'));
  // Someone else writes v2 after this editor read v1 as the latest.
  repo.state.rows.push(tenantRule({ _id: 'someone-elses-v2', version: 2 }));
  repo.findLatestVersion = async () => staleView;

  await rejects(
    admin.updatePolicy(CTX, { ruleId: 'tenant-rule-1', changes: { priority: 5 }, userId: ADMIN }),
    409,
    /changed by someone else/,
  );
});

test('a rule’s identity cannot be edited', async () => {
  const { admin } = setup();
  for (const field of ['ruleKey', 'version', 'tenantId', 'actionType']) {
    await rejects(
      admin.updatePolicy(CTX, { ruleId: 'tenant-rule-1', changes: { [field]: 'x' }, userId: ADMIN }),
      422,
      new RegExp(`cannot be edited: ${field}`),
    );
  }
});

test('an empty edit is refused', async () => {
  const { admin } = setup();
  await rejects(admin.updatePolicy(CTX, { ruleId: 'tenant-rule-1', changes: {}, userId: ADMIN }), 422);
});

/* ── Rules that would behave unlike how they read ─────────────────────── */

test('an unregistered field or a disallowed operator is refused when authored', async () => {
  const { admin } = setup();
  await rejects(
    admin.updatePolicy(CTX, {
      ruleId: 'tenant-rule-1',
      changes: { conditions: [{ field: 'order.colour', op: 'eq', value: 'red' }] },
      userId: ADMIN,
    }),
    422,
    /unknown field "order\.colour"/,
  );
});

test('FR-5.4: auto-execute is refused at authoring, not silently clamped at evaluation', async () => {
  // The engine would clamp it to confirm-required, so the admin would get a
  // rule that does something other than what it says.
  const { admin } = setup();
  await rejects(
    admin.updatePolicy(CTX, { ruleId: 'tenant-rule-1', changes: { outcome: 'auto-execute' }, userId: ADMIN }),
    422,
    /FR-5\.4/,
  );
});

test('eq with a list is refused, because it would never match', () => {
  const problems = validateRuleDefinition({
    ...tenantRule(),
    conditions: [{ field: 'order.status', op: 'eq', value: ['paid', 'packed'] }],
  });
  assert.match(problems.join(), /would never match/);
});

test('ADR 0007: a customer message naming internal identifiers is refused', () => {
  for (const message of [
    'Blocked by TENANT-HIGH-VALUE.',
    'Your order.status does not allow this.',
    'A BASE- rule stopped this.',
  ]) {
    const problems = validateRuleDefinition({ ...tenantRule(), customerMessage: message });
    assert.match(problems.join(), /must not name internal identifiers/, message);
  }
});

/* ── Creating ─────────────────────────────────────────────────────────── */

test('a new tenant rule is created at version 1, active', async () => {
  const { admin } = setup([]);
  const created = await admin.createPolicy(CTX, {
    definition: {
      ruleKey: 'TENANT-FREQUENT-CANCELLERS',
      actionType: 'order.cancel',
      conditions: [{ field: 'customer.orderCount90d', op: 'gt', value: 20 }],
      outcome: 'agent-only',
      customerMessage: 'A colleague will take a look at this one for you.',
      internalReason: 'Unusually frequent orders get a human check.',
    },
    userId: ADMIN,
  });
  assert.equal(created.version, 1);
  assert.equal(created.active, true);
  assert.equal(created.scope, 'tenant');
  assert.equal(created.priority, 100);
});

test('ADR 0008: a tenant cannot create a rule that poses as baseline', async () => {
  const { admin } = setup([]);
  await rejects(
    admin.createPolicy(CTX, {
      definition: { ...tenantRule(), ruleKey: 'BASE-CANCEL-ANYTHING', _id: undefined, tenantId: undefined, version: undefined, active: undefined },
      userId: ADMIN,
    }),
    422,
  );
  await rejects(
    admin.createPolicy(CTX, {
      definition: {
        ruleKey: 'BASE-CANCEL-ANYTHING',
        actionType: 'order.cancel',
        conditions: [],
        outcome: 'refuse',
        customerMessage: 'No.',
        internalReason: 'Posing as baseline.',
      },
      userId: ADMIN,
    }),
    422,
    /reserved for platform baseline/,
  );
});

test('a duplicate key or a badly formed key is refused', async () => {
  const { admin } = setup();
  const definition = {
    ruleKey: 'TENANT-HIGH-VALUE',
    actionType: 'order.cancel',
    conditions: [],
    outcome: 'refuse',
    customerMessage: 'Please speak to a colleague.',
    internalReason: 'Duplicate.',
  };
  await rejects(admin.createPolicy(CTX, { definition, userId: ADMIN }), 422, /already exists/);
  await rejects(admin.createPolicy(CTX, { definition: { ...definition, ruleKey: 'lowercase key' }, userId: ADMIN }), 422, /upper-case/);
});

/* ── Agreement with the other two consumers ───────────────────────────── */

test('everything this validator accepts, the schema and the engine accept too', async () => {
  // Stricter than the schema, never looser. A rule the admin API accepted but
  // the schema rejected would fail to save; one the engine rejected would fail
  // closed on every evaluation, silently escalating every conversation.
  const accepted = [
    tenantRule(),
    tenantRule({ conditions: [{ field: 'order.status', op: 'in', value: ['paid', 'packed'] }], outcome: 'refuse' }),
    tenantRule({ conditions: [], outcome: 'confirm-required' }),
    ...BASELINE_RULES.map((rule) => ({ ...structuredClone(rule), tenantId: null })),
  ];

  for (const definition of accepted) {
    assert.deepEqual(validateRuleDefinition(definition), [], definition.ruleKey);

    await new PolicyRule({ ...structuredClone(definition), _id: undefined, tenantId: null, createdBy: null }).validate();

    const decision = evaluate({
      rules: [definition],
      proposal: { actionType: 'order.cancel' },
      world: {
        order: { status: 'paid', totalMinor: 60_000, currency: 'GBP', placedAt: new Date('2026-09-14T09:00:00Z') },
        customer: { orderCount90d: 1 },
      },
      now: new Date('2026-09-14T12:00:00Z'),
    });
    assert.notEqual(decision.reason, 'invalid_rule', definition.ruleKey);
  }
});

test('a registry-invalid rule is refused by this validator AND by the schema', async () => {
  const invalid = tenantRule({ conditions: [{ field: 'order.colour', op: 'eq', value: 'red' }] });
  assert.ok(validateRuleDefinition(invalid).length > 0);
  await assert.rejects(new PolicyRule({ ...invalid, _id: undefined, tenantId: null }).validate());
});
