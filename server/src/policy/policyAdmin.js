import { AppError } from '../errors/AppError.js';
import { ACTION_TYPES, CONDITION_FIELDS, OUTCOME_LADDER } from './vocabulary.js';

/**
 * Policy administration. FR-12, ADR 0004, ADR 0008.
 *
 * This is the only way a person changes what the assistant is allowed to do,
 * so it is held to three rules:
 *
 *   1. EVERY CHANGE IS A NEW VERSION. A rule is never edited in place -- not
 *      even to disable it. A past decision stays explainable against the exact
 *      rule version that produced it (FR-12.2), and "who changed this, and when"
 *      is answered by the version rows themselves.
 *
 *   2. THE BASELINE IS NOT EDITABLE HERE. Platform rules are version-controlled
 *      in baselineRules.js and changed by a reviewed commit (ADR 0008). A lead
 *      can see them, and can make any of them stricter with a tenant rule, but
 *      cannot relax one through an API.
 *
 *   3. A RULE THAT WOULD BEHAVE DIFFERENTLY FROM HOW IT READS IS REJECTED WHEN
 *      AUTHORED, not discovered when it decides something. That includes rules
 *      that could never match, rules asking for auto-execution the deployment
 *      does not allow, and customer messages that name internal identifiers.
 *
 * The repository is injected, so all of this is testable without a database.
 */

export class RuleConflictError extends Error {
  constructor(message = 'A rule with that key and version already exists') {
    super(message);
    this.name = 'RuleConflictError';
  }
}

/** What an edit may change. Key, version, tenant and action type are the
 *  rule's IDENTITY; changing them is creating a different rule. */
const EDITABLE_FIELDS = new Set([
  'conditions',
  'outcome',
  'priority',
  'customerMessage',
  'internalReason',
  'active',
]);

const CREATE_FIELDS = new Set([
  'ruleKey',
  'actionType',
  'conditions',
  'outcome',
  'priority',
  'customerMessage',
  'internalReason',
]);

const CONDITION_KEYS = new Set(['field', 'op', 'value']);

/** Upper-case words joined by hyphens: TENANT-HIGH-VALUE. */
const RULE_KEY = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+){1,7}$/;
const BASELINE_PREFIX = 'BASE-';

const MAX_CONDITIONS = 10;
const MAX_CUSTOMER_MESSAGE = 500;
const MAX_INTERNAL_REASON = 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a complete rule definition. Returns a list of problems; empty means
 * valid.
 *
 * Deliberately STRICTER than the PolicyRule schema, never looser -- a test
 * asserts that everything accepted here is also accepted by the schema. The
 * extra strictness is aimed at rules that would save cleanly and then behave
 * unlike how they read:
 *
 *   - `eq` with an array value compares a status to an array and never
 *     matches. The rule would sit in the list looking active and do nothing.
 *   - `auto-execute` is modelled but not enabled (FR-5.4). The engine would
 *     quietly clamp it to confirm-required, so an admin who wrote it would get
 *     a rule that does something other than what it says.
 *   - A customer message naming a rule key or a condition field hands the
 *     policy boundary to the customer (ADR 0007).
 */
export function validateRuleDefinition(definition) {
  const problems = [];
  const def = isPlainObject(definition) ? definition : {};

  if (!ACTION_TYPES.includes(def.actionType)) {
    problems.push(`actionType must be one of: ${ACTION_TYPES.join(', ')}`);
  }

  if (!OUTCOME_LADDER.includes(def.outcome)) {
    problems.push(`outcome must be one of: ${OUTCOME_LADDER.join(', ')}`);
  } else if (def.outcome === 'auto-execute') {
    problems.push(
      'auto-execute is modelled but not enabled (FR-5.4): the assistant never acts without the customer confirming',
    );
  }

  if (!Number.isInteger(def.priority) || def.priority < 0 || def.priority > 10_000) {
    problems.push('priority must be a whole number from 0 to 10000');
  }

  if (!Array.isArray(def.conditions)) {
    problems.push('conditions must be an array (use [] for a rule that applies to every case)');
  } else {
    if (def.conditions.length > MAX_CONDITIONS) {
      problems.push(`a rule may have at most ${MAX_CONDITIONS} conditions`);
    }
    def.conditions.forEach((condition, index) => {
      const at = `conditions[${index}]`;
      if (!isPlainObject(condition)) {
        problems.push(`${at} must be an object with field, op and value`);
        return;
      }
      for (const key of Object.keys(condition)) {
        if (!CONDITION_KEYS.has(key)) problems.push(`${at} has an unexpected property "${key}"`);
      }

      const spec = CONDITION_FIELDS[condition.field];
      if (!spec) {
        problems.push(`${at}: unknown field ${JSON.stringify(condition.field)}`);
        return;
      }
      if (!spec.operators.includes(condition.op)) {
        problems.push(
          `${at}: operator ${JSON.stringify(condition.op)} is not allowed on ${condition.field} ` +
            `(allowed: ${spec.operators.join(', ')})`,
        );
        return;
      }

      if (spec.type === 'int') {
        if (!Number.isInteger(condition.value)) {
          problems.push(`${at}: ${condition.field} needs a whole number`);
        }
        return;
      }

      const listOperator = condition.op === 'in' || condition.op === 'nin';
      if (listOperator && (!Array.isArray(condition.value) || condition.value.length === 0)) {
        problems.push(`${at}: "${condition.op}" needs a non-empty list of values`);
        return;
      }
      if (!listOperator && Array.isArray(condition.value)) {
        problems.push(`${at}: "${condition.op}" needs a single value — compared with a list it would never match`);
        return;
      }

      const values = listOperator ? condition.value : [condition.value];
      for (const value of values) {
        if (typeof value !== 'string') {
          problems.push(`${at}: ${condition.field} values must be text`);
        } else if (spec.values && !spec.values.includes(value)) {
          problems.push(`${at}: ${condition.field} has no value ${JSON.stringify(value)}`);
        }
      }
    });
  }

  for (const [name, max] of [
    ['customerMessage', MAX_CUSTOMER_MESSAGE],
    ['internalReason', MAX_INTERNAL_REASON],
  ]) {
    const value = def[name];
    if (typeof value !== 'string' || !value.trim()) problems.push(`${name} is required`);
    else if (value.length > max) problems.push(`${name} must be at most ${max} characters`);
  }

  if (typeof def.customerMessage === 'string') {
    const internals = [def.ruleKey, BASELINE_PREFIX, ...Object.keys(CONDITION_FIELDS)].filter(
      (token) => typeof token === 'string' && token && def.customerMessage.includes(token),
    );
    if (internals.length) {
      problems.push(
        `customerMessage must not name internal identifiers (${internals.join(', ')}) — ` +
          'customers see this text (ADR 0007)',
      );
    }
  }

  return problems;
}

/** The shape staff see. Every field, because this is the internal channel --
 *  but built explicitly, so a stray property on a database row is not echoed. */
function shapeRule(row) {
  const baseline = row.tenantId === null || row.tenantId === undefined;
  return {
    id: String(row._id),
    scope: baseline ? 'baseline' : 'tenant',
    editable: !baseline,
    ruleKey: row.ruleKey,
    version: row.version,
    active: row.active,
    actionType: row.actionType,
    priority: row.priority,
    conditions: (row.conditions ?? []).map((c) => ({ field: c.field, op: c.op, value: c.value })),
    outcome: row.outcome,
    customerMessage: row.customerMessage,
    internalReason: row.internalReason,
    createdBy: row.createdBy ? String(row.createdBy) : null,
    createdAt: row.createdAt ?? null,
  };
}

function requireTenant(ctx) {
  if (!ctx?.tenantId) throw AppError.fault('Policy administration requires a tenant context');
  return String(ctx.tenantId);
}

export function makePolicyAdmin({ repo } = {}) {
  if (!repo) throw new TypeError('makePolicyAdmin requires a repo');

  /**
   * The current version of every rule this tenant is subject to, split by
   * scope (ADR 0008). Disabled rules are included, because a lead needs to see
   * a rule to re-enable it.
   */
  async function listPolicies(ctx) {
    const tenantId = requireTenant(ctx);
    const rows = await repo.listRules(ctx);

    const latest = new Map();
    for (const row of rows) {
      const baseline = row.tenantId === null || row.tenantId === undefined;
      // Defence in depth. The repo scopes this query to the tenant plus the
      // baseline; a row belonging to anyone else is dropped here even if a
      // future change to the repo let one through.
      if (!baseline && String(row.tenantId) !== tenantId) continue;
      const key = `${baseline ? 'baseline' : 'tenant'}:${row.ruleKey}`;
      const current = latest.get(key);
      if (!current || row.version > current.version) latest.set(key, row);
    }

    const ordered = [...latest.values()]
      .map(shapeRule)
      .sort((a, b) => a.priority - b.priority || a.ruleKey.localeCompare(b.ruleKey));

    const tenant = ordered.filter((rule) => rule.scope === 'tenant');
    return {
      baseline: ordered.filter((rule) => rule.scope === 'baseline'),
      tenant,
      // ADR 0008: a tenant with no rules of its own is STATED, not rendered as
      // an empty table that could be mistaken for "nothing applies". The
      // baseline always applies.
      tenantHasOwnRules: tenant.length > 0,
    };
  }

  /** Edit a tenant rule by writing its next version. */
  async function updatePolicy(ctx, { ruleId, changes, userId }) {
    requireTenant(ctx);

    if (!isPlainObject(changes) || Object.keys(changes).length === 0) {
      throw AppError.malformed('Provide at least one field to change');
    }
    const fixed = Object.keys(changes).filter((key) => !EDITABLE_FIELDS.has(key));
    if (fixed.length) {
      throw AppError.malformed(
        `These fields cannot be edited: ${fixed.join(', ')}. A rule's key, version, tenant and ` +
          'action type are its identity — create a new rule instead.',
      );
    }
    if ('active' in changes && typeof changes.active !== 'boolean') {
      throw AppError.malformed('active must be true or false');
    }

    // The repo finds tenant rules AND baseline rules by id, so a baseline rule
    // gets an honest "not editable" rather than a misleading "not found". Another
    // tenant's rule comes back null -- indistinguishable from no rule (INV-D).
    const rule = await repo.findRuleById(ctx, ruleId);
    if (!rule) throw AppError.notFound();
    if (rule.tenantId === null || rule.tenantId === undefined) {
      throw new AppError('fault', {
        message: 'Baseline rules are managed by the platform and cannot be edited here (ADR 0008)',
        status: 403,
        expected: true,
      });
    }

    // Editing from an out-of-date screen. Writing v3 over a v2 the editor never
    // saw would silently discard someone else's change.
    const latest = await repo.findLatestVersion(ctx, rule.ruleKey);
    if (!latest || latest.version !== rule.version) {
      throw AppError.stale(
        `${rule.ruleKey} has a newer version (v${latest?.version ?? '?'}); reload before editing`,
      );
    }

    const pick = (name) => (name in changes ? changes[name] : rule[name]);
    const next = {
      tenantId: rule.tenantId,
      ruleKey: rule.ruleKey,
      actionType: rule.actionType,
      version: rule.version + 1,
      // Editing a disabled rule's wording must not quietly switch it back on.
      active: pick('active'),
      priority: pick('priority'),
      conditions: pick('conditions'),
      outcome: pick('outcome'),
      customerMessage: pick('customerMessage'),
      internalReason: pick('internalReason'),
      createdBy: userId ?? null,
    };

    const problems = validateRuleDefinition(next);
    if (problems.length) throw AppError.malformed(`Rule rejected: ${problems.join('; ')}`);

    try {
      return shapeRule(await repo.insertVersion(ctx, { previous: rule, next }));
    } catch (error) {
      if (error instanceof RuleConflictError) {
        // Two editors wrote the same next version. The unique index settled it;
        // this editor lost, and is told so rather than overwriting.
        throw AppError.stale(`${rule.ruleKey} was changed by someone else; reload before editing`);
      }
      throw error;
    }
  }

  /** Create a new tenant rule at version 1. */
  async function createPolicy(ctx, { definition, userId }) {
    const tenantId = requireTenant(ctx);

    if (!isPlainObject(definition)) throw AppError.malformed('A rule definition is required');
    const unexpected = Object.keys(definition).filter((key) => !CREATE_FIELDS.has(key));
    if (unexpected.length) {
      throw AppError.malformed(`Unexpected fields: ${unexpected.join(', ')}`);
    }
    if (typeof definition.ruleKey !== 'string' || !RULE_KEY.test(definition.ruleKey)) {
      throw AppError.malformed('ruleKey must be upper-case words joined by hyphens, like TENANT-HIGH-VALUE');
    }
    if (definition.ruleKey.startsWith(BASELINE_PREFIX)) {
      throw AppError.malformed(`The ${BASELINE_PREFIX} prefix is reserved for platform baseline rules (ADR 0008)`);
    }

    const next = {
      tenantId,
      ruleKey: definition.ruleKey,
      actionType: definition.actionType,
      version: 1,
      active: true,
      priority: definition.priority ?? 100,
      conditions: definition.conditions ?? [],
      outcome: definition.outcome,
      customerMessage: definition.customerMessage,
      internalReason: definition.internalReason,
      createdBy: userId ?? null,
    };

    const problems = validateRuleDefinition(next);
    if (problems.length) throw AppError.malformed(`Rule rejected: ${problems.join('; ')}`);

    try {
      return shapeRule(await repo.insertRule(ctx, next));
    } catch (error) {
      if (error instanceof RuleConflictError) {
        throw AppError.malformed(`A rule with key ${definition.ruleKey} already exists — edit it instead`);
      }
      throw error;
    }
  }

  return { listPolicies, updatePolicy, createPolicy };
}
