import styles from './Button.module.css';

/**
 * The only button in the app. Ported from Project 2.
 *
 * Two details that matter:
 *
 * 1. `loading` sets both `disabled` and `aria-busy`. Disabled alone stops the
 *    double-submit; aria-busy is what tells a screen reader something is in
 *    flight. Neither replaces the other.
 *
 * 2. The label stays visible while loading and the spinner is added beside it.
 *    Swapping label for spinner changes the button's width mid-click, which
 *    shifts everything next to it -- and loses the only clue about what is
 *    actually happening.
 *
 * On VARIANTS in this project specifically: the confirmation dialog uses
 * `danger` for the mutating action and `secondary` for the safe one, at
 * deliberately COMPARABLE visual weight. Making the safe option a big primary
 * button would nudge users away from a legitimate cancellation; making the
 * destructive one primary would invite the reflexive click ADR 0009 exists to
 * prevent. Neither button should be the one you press without reading.
 */
export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  type = 'button',
  fullWidth = false,
  ...rest
}) {
  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      className={[
        styles.button,
        styles[variant],
        styles[size],
        fullWidth ? styles.fullWidth : '',
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      <span>{children}</span>
    </button>
  );
}
