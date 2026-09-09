import { describe, expect, it } from 'vitest';
import { OUTCOME, TIER_LADDER, didMutate, mostRestrictive } from '../lib/outcomes.js';

describe('outcome vocabulary', () => {
  it('exactly one outcome represents a mutation', () => {
    const mutating = Object.values(OUTCOME).filter(didMutate);
    expect(mutating).toEqual([OUTCOME.EXECUTED]);
  });

  it('has seven terminal outcomes', () => {
    // Phase 3 section 4, with `expired` added in Phase 4. If this number
    // changes, the audit UI and the outcome badge mapping must change with it.
    expect(Object.values(OUTCOME)).toHaveLength(7);
  });
});

describe('the policy outcome ladder', () => {
  it('is ordered most permissive first', () => {
    expect(TIER_LADDER).toEqual([
      'auto-execute',
      'confirm-required',
      'agent-only',
      'refuse',
    ]);
  });

  it('resolves conflicts to the more restrictive outcome', () => {
    expect(mostRestrictive('confirm-required', 'agent-only')).toBe('agent-only');
    expect(mostRestrictive('refuse', 'auto-execute')).toBe('refuse');
    expect(mostRestrictive('agent-only', 'agent-only')).toBe('agent-only');
  });

  it('ADR 0008: a tenant rule can only ever move an outcome further right', () => {
    // The property that makes baseline layering safe with no branch in the
    // engine. A permissive tenant rule loses to a restrictive baseline one.
    const baseline = 'refuse';
    const tenantTriesToRelax = 'auto-execute';
    expect(mostRestrictive(baseline, tenantTriesToRelax)).toBe('refuse');
  });
});
