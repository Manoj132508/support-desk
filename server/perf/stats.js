/**
 * Latency statistics. Pure: numbers in, numbers out.
 *
 * Percentiles use the NEAREST-RANK method: the p-th percentile is a value that
 * was actually observed, never one interpolated between two samples. A p95
 * interpolated from samples of 1 ms and 900 ms would be a latency nobody ever
 * waited for.
 */

export function percentile(sorted, p) {
  if (!Array.isArray(sorted) || sorted.length === 0) {
    throw new RangeError('percentile() needs at least one sample');
  }
  if (!(p > 0 && p <= 100)) throw new RangeError('p must be in (0, 100]');
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1];
}

/** Summary of a list of durations in milliseconds. The input is not modified. */
export function summarise(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new RangeError('summarise() needs at least one sample');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
    mean: total / sorted.length,
  };
}

/** A duration in milliseconds, in the unit that makes it readable. */
export function formatDuration(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
