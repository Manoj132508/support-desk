import { useId } from 'react';
import styles from './Input.module.css';

/**
 * Labelled text input. Ported from Project 2.
 *
 * The label is not optional and there is no `placeholder`-as-label escape
 * hatch. A placeholder disappears the moment someone types, so it fails
 * exactly when a user needs to check what a field was for -- and it is invisible
 * to a screen reader as a label. `useId` ties label to input without the caller
 * having to invent unique ids.
 *
 * `error` is wired to `aria-describedby` and `aria-invalid` rather than only
 * being rendered in red, because colour alone is not an accessible signal
 * (NFR-8).
 */
export default function Input({ label, error, hint, id, ...rest }) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const messageId = `${inputId}-message`;
  const message = error ?? hint;

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className={[styles.input, error ? styles.invalid : ''].filter(Boolean).join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        {...rest}
      />
      {message && (
        <p
          id={messageId}
          className={error ? styles.error : styles.hint}
          role={error ? 'alert' : undefined}
        >
          {message}
        </p>
      )}
    </div>
  );
}
