/**
 * Which sources to list under an assistant's answer.
 *
 * For a small help centre the model is given every source, not just the few
 * that matched (ADR 0011), so the evidence for an answer names every article
 * section. Listing all of them would say nothing about the answer. So the list
 * shows the sources the answer CITES, by its [n] markers, numbered as the
 * markers are -- and falls back to everything it was given when it cannot tell:
 *
 * - evidence without numbers, which cannot be matched to markers;
 * - a finished answer that cites nothing, where the full list is still the
 *   honest statement of what it was based on.
 *
 * While an answer is still streaming and has cited nothing yet, the list is
 * empty rather than full, so it grows as citations appear instead of shrinking.
 */
export function citedSources(evidence, text, { streaming = false } = {}) {
  const items = evidence ?? [];
  if (items.length === 0 || !items.every((item) => Number.isInteger(item.n))) return items;

  const cited = new Set([...(text ?? '').matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
  if (cited.size === 0) return streaming ? [] : items;
  return items.filter((item) => cited.has(item.n));
}
