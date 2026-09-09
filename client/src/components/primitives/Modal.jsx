import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import styles from './Modal.module.css';

/**
 * Accessible modal dialog. PORTED FROM PROJECT 2, with one deliberate change --
 * see `initialFocus` below.
 *
 * Four things a div with `position: fixed` does not give you, and which are
 * the whole reason this is a component rather than inline markup:
 *
 * 1. FOCUS MOVES IN on open, and RETURNS to the trigger on close. Without the
 *    return, closing a dialog dumps keyboard focus back at the top of the
 *    document and the user has to tab all the way to where they were.
 * 2. FOCUS IS TRAPPED. Tab from the last control wraps to the first instead of
 *    escaping to the page behind, which a screen-reader user cannot see.
 * 3. ESCAPE CLOSES IT.
 * 4. `aria-modal` + a dialog role tell assistive technology the rest of the
 *    page is inert.
 *
 * ── THE CHANGE FROM PROJECT 2 ──────────────────────────────────────────────
 *
 * Project 2's version focused the first focusable control on open. That is the
 * conventional behaviour and it is WRONG HERE.
 *
 * ADR 0009 property 2: the confirm button must not be focused on open, because
 * this dialog authorises an action with consequences. If the primary button
 * holds focus, a muscle-memory Enter carried over from the message composer
 * authorises a cancellation the user never read. So `initialFocus` defaults to
 * 'heading' -- focus lands on the dialog's title, Enter does nothing, and the
 * user must deliberately move to a button.
 *
 * `initialFocus="first"` restores Project 2's behaviour for ordinary dialogs
 * where speed is the right trade. The default is the safe one, because the
 * dangerous option should be the one you have to ask for.
 */
export default function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  initialFocus = 'heading',
  role = 'dialog',
  describedBy,
}) {
  const dialogRef = useRef(null);
  const titleRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;

    if (initialFocus === 'first') {
      const focusables = dialogRef.current?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (focusables?.[0] ?? dialogRef.current)?.focus();
    } else {
      // The heading carries tabIndex={-1} so it is programmatically focusable
      // without entering the tab order.
      (titleRef.current ?? dialogRef.current)?.focus();
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = dialogRef.current?.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!items?.length) return;

      const first = items[0];
      const last = items[items.length - 1];

      // The wrap. Without it, Tab walks out of the dialog into the page behind.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose, initialFocus]);

  if (!open) return null;

  return createPortal(
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role={role}
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={describedBy}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="modal-title" className={styles.title} ref={titleRef} tabIndex={-1}>
          {title}
        </h2>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
