import { describe, it, expect } from 'vitest';
import { CrossSourceMatcher, SearchProvider, SourceMatch } from '../src/engines/CrossSourceMatcher';

function makeProvider(name: string, results: SourceMatch[], priority = 1): SearchProvider {
  return {
    name,
    priority,
    search: async (_query: string) => results,
  };
}

describe('CrossSourceMatcher', () => {
  const matcher = new CrossSourceMatcher();

  describe('crossTitleSimilarity', () => {
    it('returns 1 for exact match', () => {
      expect(matcher.crossTitleSimilarity('Naruto', 'Naruto')).toBe(1);
    });

    it('returns 0.95 for substring match', () => {
      const sim = matcher.crossTitleSimilarity('One Piece', 'One Piece: Ace Story');
      expect(sim).toBeGreaterThanOrEqual(0.9);
    });

    it('handles diacritics (accents)', () => {
      const sim = matcher.crossTitleSimilarity('Pokémon', 'Pokemon');
      expect(sim).toBeGreaterThan(0.8);
    });

    it('matches despite different word order', () => {
      const sim = matcher.crossTitleSimilarity('Attack on Titan', 'Titan Attack');
      expect(sim).toBeGreaterThan(0.4);
    });

    it('returns 0 for completely different titles', () => {
      const sim = matcher.crossTitleSimilarity('Naruto', 'XYZXYZ');
      expect(sim).toBe(0);
    });
  });

  describe('match', () => {
    it('finds best match across providers', async () => {
      const providers = [
        makeProvider('mangadex', [
          { source: 'mangadex', id: '1', title: 'Naruto', matchScore: 0, query: '' },
          { source: 'mangadex', id: '2', title: 'Boruto', matchScore: 0, query: '' },
        ]),
        makeProvider('spnmanga', [
          { source: 'spnmanga', id: '3', title: 'Naruto Shippuden', matchScore: 0, query: '' },
        ]),
      ];

      const result = await matcher.match(['Naruto'], providers);
      expect(result.best).not.toBeNull();
      expect(result.best!.source).toBe('mangadex');
      expect(result.best!.title).toBe('Naruto');
    });

    it('deduplicates by source keeping best score', async () => {
      const providers = [
        makeProvider('site-a', [
          { source: 'site-a', id: '1', title: 'Solo Leveling', matchScore: 0, query: '' },
          { source: 'site-a', id: '2', title: 'Solo Leveling Ragnarok', matchScore: 0, query: '' },
        ]),
      ];

      const result = await matcher.match(['Solo Leveling'], providers);
      expect(result.matches.filter(m => m.source === 'site-a').length).toBe(1);
    });

    it('handles multi-title search', async () => {
      const providers = [
        makeProvider('site', [
          { source: 'site', id: '1', title: 'Kimetsu no Yaiba', matchScore: 0, query: '' },
        ]),
      ];

      const result = await matcher.match(
        ['Demon Slayer', 'Kimetsu no Yaiba', 'Guardianes de la Noche'],
        providers,
      );
      expect(result.best).not.toBeNull();
      expect(result.matches[0].matchScore).toBeGreaterThan(0.7);
    });

    it('returns null best when no matches found', async () => {
      const providers = [
        makeProvider('site', [
          { source: 'site', id: '1', title: 'XYZ', matchScore: 0, query: '' },
        ]),
      ];

      const result = await matcher.match(['Naruto'], providers);
      expect(result.best).toBeNull();
    });

    it('respects minScore threshold', async () => {
      const providers = [
        makeProvider('site', [
          { source: 'site', id: '1', title: 'Boruto', matchScore: 0, query: '' },
        ]),
      ];

      const result = await matcher.match(['Naruto'], providers, { minScore: 0.9 });
      expect(result.best).toBeNull(); // "Naruto" vs "Boruto" < 0.9
    });
  });

  describe('matchSingle', () => {
    it('returns best match for single provider', async () => {
      const provider = makeProvider('site', [
        { source: 'site', id: '1', title: 'One Piece', matchScore: 0, query: '' },
        { source: 'site', id: '2', title: 'Two Piece', matchScore: 0, query: '' },
      ]);

      const match = await matcher.matchSingle(['One Piece'], provider);
      expect(match).not.toBeNull();
      expect(match!.title).toBe('One Piece');
    });
  });

  describe('selectByResultCount', () => {
    it('selects provider with most results', () => {
      const matches: SourceMatch[] = [
        { source: 'a', id: '1', title: 'Naruto', matchScore: 0.9, query: '', resultCount: 700 },
        { source: 'b', id: '2', title: 'Naruto', matchScore: 0.85, query: '', resultCount: 100 },
        { source: 'c', id: '3', title: 'Naruto', matchScore: 0.8, query: '', resultCount: 50 },
      ];

      const best = matcher.selectByResultCount(matches);
      expect(best!.source).toBe('a');
    });

    it('adds bonus for sources with substantial content', () => {
      const matches: SourceMatch[] = [
        { source: 'api', id: '1', title: 'Title', matchScore: 0.9, query: '', resultCount: 15 },
        { source: 'local', id: '2', title: 'Title', matchScore: 0.85, query: '', resultCount: 100 },
      ];

      const best = matcher.selectByResultCount(matches, 20, 5);
      expect(best!.source).toBe('local'); // 100 + 5 bonus > 15
    });
  });
});
