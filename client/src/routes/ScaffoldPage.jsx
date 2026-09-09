/**
 * Placeholder for the screens Phase 4 specified but later phases build.
 *
 * These exist now so routing, guards and the layout shell can be exercised and
 * tested before any of the real screens are written. Each one names the phase
 * that replaces it, so a stub cannot quietly become permanent.
 */
export default function ScaffoldPage({ title, phase, children }) {
  return (
    <div className="scaffold-page">
      <h1>{title}</h1>
      <p>
        Built in <strong>{phase}</strong>. This placeholder exists so routing and guards can be
        exercised from Phase 5 onward.
      </p>
      {children}
    </div>
  );
}
