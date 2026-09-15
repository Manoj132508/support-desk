import Button from './primitives/Button.jsx';
import { ERROR_KIND, isPolicyKind } from '../lib/outcomes.js';
import styles from './PolicyBlock.module.css';

/**
 * The component Phase 4 section 5 exists to produce.
 *
 * THE RULE: three of the four error kinds are not errors. `refused`, `stale`
 * and `malformed` are correct outcomes of a working system, and they render in
 * the POLICY language -- a bordered violet block that reads as a limit stated
 * calmly. Only `fault` renders in the FAULT language, with the warning colour
 * and a retry.
 *
 * Why this is a component and not a styled div at each call site: if every
 * caller decides how to render a refusal, one of them will reach for the error
 * toast that is already lying around. Then users learn the assistant is broken,
 * agents learn to dismiss refusals, and the demonstration this whole project
 * exists for disappears into an error state. Centralising it means the decision
 * was made once, here, and is tested.
 *
 * TWO CHANNELS (ADR 0007). `customerMessage` is static, rule-authored text --
 * never model-generated, because a model paraphrasing a policy refusal
 * reintroduces exactly the coupling ADR 0002 removed. `detail` carries the rule
 * key, version, matched conditions and internal reason, and is rendered ONLY
 * when `showDetail` is set, which is only ever true on internal surfaces. The
 * customer path cannot leak it because it is not passed on that path.
 *
 * EVERY POLICY BLOCK ENDS IN A NEXT STEP, AND SAYS TRUTHFULLY WHICH ONE
 * (ADR 0010). Either a colleague is already coming -- `escalated`, which only
 * the server can report -- or the block offers one. Nothing here says a
 * colleague is coming unless `escalated` is set: not the heading, not the
 * fallback text. And a block that has escalated offers no button to ask again.
 */

const HEADING = {
  [ERROR_KIND.REFUSED]: "This can't be done here",
  [ERROR_KIND.STALE]: 'This is no longer possible',
  [ERROR_KIND.MALFORMED]: "This couldn't be completed",
  [ERROR_KIND.FAULT]: 'Something went wrong',
};

const ESCALATED_HEADING = 'A colleague will pick this up';

/*
 * Generic text for a rule with no customer message. Two versions of each, and
 * only the escalated one may mention a colleague. The escalated refusal is ADR
 * 0007's own fallback sentence.
 */
const FALLBACK_MESSAGE = {
  [ERROR_KIND.REFUSED]: "I'm not able to do that automatically.",
  [ERROR_KIND.STALE]: "That's no longer possible, because the order has moved on since I offered it.",
  [ERROR_KIND.MALFORMED]: "I couldn't complete that request.",
  [ERROR_KIND.FAULT]: 'Something went wrong on our side.',
};

const ESCALATED_FALLBACK_MESSAGE = {
  [ERROR_KIND.REFUSED]: "I'm not able to do that automatically. Let me bring in a colleague who can help.",
  [ERROR_KIND.STALE]:
    "That's no longer possible, because the order has moved on since I offered it. A colleague will look into it.",
  [ERROR_KIND.MALFORMED]: "I couldn't complete that request. Let me bring in a colleague who can help.",
  [ERROR_KIND.FAULT]: "Something went wrong on our side, so I've passed this to a colleague.",
};

export default function PolicyBlock({
  kind,
  customerMessage,
  detail,
  showDetail = false,
  escalated = false,
  onEscalate,
  escalating = false,
  onRetry,
  alternative,
}) {
  const isPolicy = isPolicyKind(kind);
  // An unknown kind renders as a fault, never as a decision nobody made.
  const known = Object.hasOwn(HEADING, kind) ? kind : ERROR_KIND.FAULT;

  // A rule with a missing customerMessage falls back to generic copy. It NEVER
  // falls back to `detail` -- a missing field must not become a leak (ADR 0007).
  const message = customerMessage || (escalated ? ESCALATED_FALLBACK_MESSAGE : FALLBACK_MESSAGE)[known];
  const heading = isPolicy && escalated ? ESCALATED_HEADING : HEADING[known];

  return (
    <div
      className={[styles.block, isPolicy ? styles.policy : styles.fault].join(' ')}
      role={isPolicy ? 'note' : 'alert'}
      data-kind={kind}
    >
      <div className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          {isPolicy ? '⛊' : '!'}
        </span>
        <span className={styles.heading}>{heading}</span>
      </div>

      <p className={styles.message}>{message}</p>

      {alternative && <p className={styles.alternative}>{alternative}</p>}

      {/* Internal surfaces only. The customer path never receives `detail`. */}
      {showDetail && detail && (
        <dl className={styles.detail}>
          <div>
            <dt>Rule</dt>
            <dd>
              <code>
                {detail.ruleKey ?? 'no rule matched'}
                {detail.ruleVersion ? ` · v${detail.ruleVersion}` : ''}
              </code>
            </dd>
          </div>
          {detail.outcome && (
            <div>
              <dt>Outcome</dt>
              <dd>
                <code>{detail.outcome}</code>
              </dd>
            </div>
          )}
          {Array.isArray(detail.matched) && detail.matched.length > 0 && (
            <div>
              <dt>Matched</dt>
              <dd>
                <code>{detail.matched.join(', ')}</code>
              </dd>
            </div>
          )}
          {detail.internalReason && (
            <div>
              <dt>Why</dt>
              <dd>{detail.internalReason}</dd>
            </div>
          )}
        </dl>
      )}

      <div className={styles.actions}>
        {isPolicy && !escalated && onEscalate && (
          <Button variant="secondary" size="sm" onClick={onEscalate} loading={escalating}>
            Talk to a person
          </Button>
        )}
        {/* A fault that escalated was recorded as terminal: retrying it cannot
            work, so no retry is offered. */}
        {!isPolicy && !escalated && onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
