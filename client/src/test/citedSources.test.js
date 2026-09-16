import { describe, expect, it } from 'vitest';
import { citedSources } from '../lib/citedSources.js';

const source = (n) => ({ ref: `doc:${n}`, n, documentName: `Article ${n}`, section: null });
const all = [1, 2, 3, 4, 5, 6, 7].map(source);

describe('citedSources', () => {
  it('lists the sources the answer cites, not every source it was given', () => {
    expect(citedSources(all, 'You have 30 days [6], and postage is not refunded [7][6].').map((s) => s.n)).toEqual([6, 7]);
  });

  it('keeps each source’s own number so the list matches the markers', () => {
    const [item] = citedSources(all, 'Express costs £5.95 [4].');
    expect(item.n).toBe(4);
  });

  it('shows everything given when a finished answer cites nothing', () => {
    expect(citedSources(all, 'Express delivery costs £5.95.')).toHaveLength(7);
  });

  it('shows nothing yet while an answer streams without a citation, so the list only grows', () => {
    expect(citedSources(all, 'Express delivery', { streaming: true })).toEqual([]);
    expect(citedSources(all, 'Express delivery costs £5.95 [4', { streaming: true })).toEqual([]);
    expect(citedSources(all, 'Express delivery costs £5.95 [4]', { streaming: true }).map((s) => s.n)).toEqual([4]);
  });

  it('shows everything when the evidence carries no numbers to match', () => {
    const unnumbered = [{ ref: 'doc:1', n: null }, { ref: 'doc:2', n: null }];
    expect(citedSources(unnumbered, 'An answer [1].')).toEqual(unnumbered);
  });

  it('ignores a marker that matches no source rather than inventing one', () => {
    expect(citedSources(all, 'See [9] and [2].').map((s) => s.n)).toEqual([2]);
  });

  it('copes with no evidence at all', () => {
    expect(citedSources([], 'text [1]')).toEqual([]);
    expect(citedSources(undefined, 'text')).toEqual([]);
  });
});
