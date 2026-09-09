import Modal from './primitives/Modal.jsx';
import Button from './primitives/Button.jsx';
import styles from './ConfirmationDialog.module.css';

/**
 * THE component. Every architectural decision in this project funnels into it.
 *
 * The trust boundary, the policy engine, the execution-time re-check and the
 * audit trail all exist to deliver one decision to one control. Nothing
 * downstream of this dialog can protect INV-A -- by the time the user clicks,
 * the backend has done everything it can. So this file implements ADR 0009's
 * seven properties literally, and each one is tested.
 *
 * 1. Verb-specific labels, never OK/Cancel        -> ACTION_LABELS
 * 2. Confirm button not focused on open           -> initialFocus="heading"
 * 3. Action text from the stored proposal         -> proposal.confirmText
 * 4. Dismissal is not a decision                  -> onDismiss vs onReject
 * 5. Nothing times out into consent               -> no timer exists here
 * 6. Fully keyboard operable                      -> Modal's focus trap
 * 7. One proposal, one dialog                     -> single `proposal` prop
 */

/**
 * Property 1, and the sharpest detail in the project.
 *
 * The MVP action is CANCELLING AN ORDER. A dialog with a "Cancel" button is
 * catastrophically ambiguous: it plausibly means "cancel the order" or "cancel
 * this dialog", and those are opposite outcomes. A customer trying to KEEP
 * their order who clicks the button marked Cancel gets exactly what they were
 * trying to avoid.
 *
 * So both buttons name their outcome, and the mapping is per action type.
 * Adding an action means adding its labels here -- deliberate friction, the
 * same reasoning as ADR 0002: an action that is cheap to add is an action
 * nobody re-reasons about.
 */
const ACTION_LABELS = {
  'order.cancel': {
    title: 'Cancel this order?',
    confirm: (p) => `Cancel order ${p.target?.orderNumber ?? ''}`.trim(),
    reject: () => 'Keep my order',
  },
};

export default function ConfirmationDialog({
  open,
  proposal,
  onConfirm,
  onReject,
  onDismiss,
  busy = false,
}) {
  if (!open || !proposal) return null;

  const labels = ACTION_LABELS[proposal.actionType];

  /**
   * An action type with no label mapping CANNOT BE CONFIRMED HERE.
   *
   * The tempting alternative is a generic "Confirm" fallback. That would mean a
   * new action type -- one nobody has written human-readable labels for, and
   * therefore one nobody has thought about at the UI layer -- becomes
   * confirmable the moment the server can propose it. Failing closed keeps the
   * UI honest: if we cannot describe what the button does, we do not offer it.
   */
  if (!labels) {
    return (
      <Modal
        open={open}
        onClose={onDismiss}
        title="This action can't be confirmed here"
        role="alertdialog"
        footer={
          <Button variant="secondary" onClick={onDismiss}>
            Close
          </Button>
        }
      >
        <p className={styles.body}>
          The assistant proposed an action this screen doesn&apos;t know how to describe
          (<code>{proposal.actionType}</code>), so it can&apos;t be confirmed. A support agent
          will pick this up.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      // Property 4: Escape and backdrop DISMISS. They do not decide.
      // The proposal stays pending and reappears as an inline card, so the
      // audit can tell "I declined" apart from "I did not decide".
      onClose={onDismiss}
      title={labels.title}
      // Property 6 + 2: alertdialog role, and focus lands on the heading rather
      // than on the confirm button, so a muscle-memory Enter carried over from
      // the message composer cannot authorise anything.
      role="alertdialog"
      initialFocus="heading"
      describedBy="confirmation-action"
      footer={
        <>
          {/* Property 1: both buttons name their outcome. */}
          <Button variant="secondary" onClick={onReject} disabled={busy}>
            {labels.reject(proposal)}
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy}>
            {labels.confirm(proposal)}
          </Button>
        </>
      }
    >
      <p className={styles.body}>
        This will happen straight away and can&apos;t be undone from here.
      </p>

      {/*
        Property 3. `confirmText` is rendered by the SERVER from the stored
        proposal record, never from model output (FR-6.1), and the exact string
        shown here is persisted as `confirmedText` on the outcome record -- which
        is how "the UI showed the real action" becomes provable rather than
        merely intended.

        It is visually distinct from assistant prose on purpose: a bordered
        block in monospace cannot be mistaken for something the model said.
      */}
      <div className={styles.action} id="confirmation-action">
        {proposal.confirmText}
      </div>
    </Modal>
  );
}
