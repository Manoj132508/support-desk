import { OUTCOME, OUTCOME_LABEL } from '../../lib/outcomes.js';
import styles from './Badge.module.css';

export default function Badge({ tone = 'neutral', children }) {
  return <span className={[styles.badge, styles[tone]].join(' ')}>{children}</span>;
}

/**
 * One badge per terminal outcome (Phase 3 section 4).
 *
 * The tone mapping is the visual expression of the rule that runs through this
 * whole project: only `failed` is an error. A refusal, an escalation, a
 * customer declining, an expiry -- these are a working system declining to act,
 * and they are toned as information, not breakage.
 */
const OUTCOME_TONE = {
  [OUTCOME.EXECUTED]: 'success',
  [OUTCOME.REFUSED_AT_PROPOSAL]: 'policy',
  [OUTCOME.REFUSED_AT_EXECUTION]: 'policy',
  [OUTCOME.ESCALATED_AT_PROPOSAL]: 'accent',
  [OUTCOME.REJECTED_BY_CUSTOMER]: 'neutral',
  [OUTCOME.EXPIRED]: 'neutral',
  [OUTCOME.FAILED]: 'warn',
};

export function OutcomeBadge({ outcome }) {
  return (
    <Badge tone={OUTCOME_TONE[outcome] ?? 'neutral'}>
      {OUTCOME_LABEL[outcome] ?? outcome}
    </Badge>
  );
}
