import { evaluate as realEvaluate } from '../../src/policy/engine.js';
import { makeActionService } from '../../src/policy/actionService.js';
import { AppError } from '../../src/errors/AppError.js';
import { buildSeedData } from '../../scripts/seedData.js';
import { makeFakeActionRepo } from '../../test/support/fakeActionRepo.js';
import { DECISION_CASES, END_TO_END_CASES, EXTRA_RULES, NOW } from './goldenSet.js';
import { LEVEL, classifyDecision, classifyEndToEnd, summarise } from './metrics.js';

/**
 * Runs the golden set. Everything it depends on is injectable -- the engine,
 * the cases and the rule sets -- so its own tests can hand it a sabotaged
 * engine or a weakened rule set and prove the eval notices.
 *
 * THE RULES ARE THE SEEDED ONES. Tenant rule sets are built from the same
 * `buildSeedData` the seed script writes to the database, so the eval measures
 * the rules that ship (ADR 0004, ADR 0008), not a copy kept beside it.
 *
 * The end-to-end cases use the in-memory repository from the server's tests,
 * which enforces the same guarantees as MongoDB -- a unique idempotency key,
 * atomic and conditional execution, escalation committed with its outcome --
 * and is told so in its own header. What needs a real replica set is listed in
 * the Phase 13 doc, as in every phase before it.
 */

export async function loadRuleSets() {
  const seed = await buildSeedData({ now: new Date(NOW), hashPassword: async () => 'not-a-real-hash' });
  const tenant = (slug) => seed.tenants.find((candidate) => candidate.slug === slug);
  const rulesFor = (slug) =>
    seed.policyRules.filter((rule) => rule.tenantId === null || String(rule.tenantId) === String(tenant(slug)._id));

  const acme = rulesFor('acme');
  const globex = rulesFor('globex');

  return {
    acme,
    globex,
    'acme-auto-execute': [...acme, EXTRA_RULES.autoExecuteCheap],
    'acme-relaxation': [...acme, EXTRA_RULES.relaxDelivered],
    'acme-retired-freeze': [...acme, EXTRA_RULES.retiredFreeze],
    'auto-execute-only': [EXTRA_RULES.autoExecuteCheap],
    'invalid-rule': [...globex, EXTRA_RULES.unknownField],
    none: [],
  };
}

function rulesNamed(ruleSets, name, caseId) {
  const rules = ruleSets[name];
  if (!rules) throw new Error(`Case ${caseId} names an unknown rule set: ${name}`);
  return rules;
}

const CTX = Object.freeze({ tenantId: 'tenant-eval', correlationId: 'policy-eval' });
const CUSTOMERS = Object.freeze({ ana: 'customer-ana', ben: 'customer-ben' });

async function runScenario(testCase, ruleSets, now) {
  const orders = testCase.orders.map((spec) => ({
    _id: `order-${spec.orderNumber}`,
    __v: 0,
    tenantId: CTX.tenantId,
    customerId: CUSTOMERS[spec.customer],
    orderNumber: spec.orderNumber,
    status: spec.status,
    items: [{ sku: `SKU-${spec.orderNumber}`, name: 'Eval item', qty: 1, unitPriceMinor: spec.totalMinor }],
    currency: 'GBP',
    totalMinor: spec.totalMinor,
    placedAt: new Date(now.getTime() - 30 * 3_600_000),
  }));
  const statusBefore = new Map(orders.map((stored) => [stored._id, stored.status]));

  const repo = makeFakeActionRepo({ orders, rules: rulesNamed(ruleSets, testCase.ruleSet, testCase.id) });
  const service = makeActionService({ repo, clock: () => now });

  const proposals = [];
  const answers = [];
  let lastProposalId = null;

  try {
    for (const step of testCase.steps) {
      const customerId = CUSTOMERS[step.as ?? 'ana'];
      switch (step.do) {
        case 'propose': {
          const result = await service.propose({
            ctx: CTX,
            customerId,
            conversationId: 'conversation-eval',
            raw: step.raw,
            correlationId: CTX.correlationId,
          });
          proposals.push(result.kind);
          lastProposalId = result.proposalId;
          break;
        }
        case 'confirm':
        case 'reject':
          try {
            const result = await service[step.do]({ ctx: CTX, customerId, proposalId: lastProposalId, userId: `user-${step.as}` });
            answers.push(result.kind);
          } catch (error) {
            // A refusal to confirm is an ordinary answer; anything else is a
            // broken run.
            if (!(error instanceof AppError)) throw error;
            answers.push(String(error.status));
          }
          break;
        case 'setStatus': {
          const stored = repo.state.orders.get(`order-${step.orderNumber}`);
          stored.status = step.status;
          stored.__v += 1;
          break;
        }
        case 'addRule':
          repo.state.rules = [...repo.state.rules, step.rule];
          break;
        default:
          throw new Error(`Unknown step "${step.do}"`);
      }
    }
  } catch (error) {
    return { error: error.message, firstProposal: proposals[0] ?? null, executions: 0, answers };
  }

  // Counted two ways, and the larger is used: orders that became cancelled
  // during the run, and executed outcome rows. If the two ever disagreed, the
  // eval would still see the worse of them.
  const cancelledOrders = [...repo.state.orders.values()].filter(
    (stored) => stored.status === 'cancelled' && statusBefore.get(stored._id) !== 'cancelled',
  ).length;
  const executedRows = [...repo.state.outcomesByKey.values()].filter((row) => row.outcome === 'executed').length;

  return { firstProposal: proposals[0] ?? null, proposals, answers, executions: Math.max(cancelledOrders, executedRows) };
}

export async function runPolicyEval({
  evaluate = realEvaluate,
  decisionCases = DECISION_CASES,
  endToEndCases = END_TO_END_CASES,
  ruleSets,
} = {}) {
  const sets = ruleSets ?? (await loadRuleSets());
  const now = new Date(NOW);
  const results = [];

  for (const testCase of decisionCases) {
    let actual;
    try {
      const decided = evaluate({
        rules: rulesNamed(sets, testCase.ruleSet, testCase.id),
        proposal: { actionType: testCase.actionType },
        world: testCase.world,
        now,
      });
      actual = {
        outcome: decided.outcome,
        ruleKey: decided.ruleKey ?? null,
        reason: decided.reason ?? null,
        clampedFrom: decided.clampedFrom ?? null,
      };
    } catch (error) {
      actual = { error: error.message };
    }
    results.push({
      id: testCase.id,
      kind: 'decision',
      why: testCase.why,
      expected: testCase.expected,
      expectedLevel: LEVEL[testCase.expected.outcome],
      actual,
      classification: classifyDecision(testCase.expected, actual),
    });
  }

  for (const testCase of endToEndCases) {
    const actual = await runScenario(testCase, sets, now);
    results.push({
      id: testCase.id,
      kind: 'end-to-end',
      why: testCase.why,
      expected: testCase.expected,
      expectedLevel: LEVEL[testCase.expected.firstProposal],
      actual,
      classification: classifyEndToEnd(testCase.expected, actual),
    });
  }

  return { results, summary: summarise(results) };
}
