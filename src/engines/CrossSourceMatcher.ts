import { textSimilarity } from '../analysis/SessionMemory';
import { getLogger } from '../utils/logger';

export interface SourceMatch {
  source: string;
  id: string;
  title: string;
  url?: string;
  matchScore: number;
  query: string;
  resultCount?: number;
  extra?: Record<string, unknown>;
}

export interface CrossSourceResult {
  query: string;
  titles: string[];
  matches: SourceMatch[];
  best: SourceMatch | null;
  durationMs: number;
}

export interface SearchProvider {
  name: string;
  search(query: string): Promise<SourceMatch[]>;
  priority?: number;
}

export interface CrossSourceOptions {
  minScore?: number;
  maxQueriesPerSource?: number;
  deduplicateBySource?: boolean;
}

/**
 * Cross-source content matcher.
 * Given multiple title variants, searches across providers and finds the best match
 * using dual-similarity scoring (Levenshtein + word Jaccard).
 */
export class CrossSourceMatcher {
  /**
   * Search across all providers with all title variants.
   * Returns ranked matches per source and the overall best match.
   *
   * @param titles - Title variants to search (canonical, alt titles, romanized, etc.)
   * @param providers - Source providers with `search(query)` method
   * @param options - Matching options
   */
  async match(
    titles: string[],
    providers: SearchProvider[],
    options: CrossSourceOptions = {},
  ): Promise<CrossSourceResult> {
    const { minScore = 0.4, maxQueriesPerSource = 6, deduplicateBySource = true } = options;
    const startTime = Date.now();
    const uniqueTitles = [...new Set(titles.filter(Boolean))];
    const log = getLogger();

    log.info({ titles: uniqueTitles.length, providers: providers.length }, 'CrossSourceMatcher: starting');

    // Sort providers by priority (lower = first)
    const sorted = [...providers].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

    // Search all providers in parallel with all titles
    const rawMatches: SourceMatch[] = [];

    const searchTasks = sorted.map(async (provider) => {
      const queries = uniqueTitles.slice(0, maxQueriesPerSource);
      for (const q of queries) {
        if (!q || q.length < 2) continue;
        try {
          log.debug({ provider: provider.name, query: q }, 'CrossSourceMatcher: searching');
          const candidates = await provider.search(q);
          if (!candidates || candidates.length === 0) continue;

          // Find best candidate for this query using dual-similarity
          let best: SourceMatch | null = null;
          let bestScore = 0;

          for (const c of candidates) {
            // Try all reference titles, take max similarity
            let maxScore = 0;
            for (const refTitle of uniqueTitles) {
              const sim = this.crossTitleSimilarity(refTitle, c.title);
              if (sim > maxScore) maxScore = sim;
            }

            if (maxScore > bestScore && maxScore >= minScore) {
              bestScore = maxScore;
              best = { ...c, matchScore: maxScore, query: q };
            }
          }

          if (best) {
            rawMatches.push(best);
            break; // Found match for this provider, move to next
          }
        } catch (err) {
          log.debug({ provider: provider.name, query: q, error: (err as Error).message }, 'Search failed');
        }
      }
    });

    await Promise.allSettled(searchTasks);

    // Deduplicate by source (keep best score)
    let matches = rawMatches;
    if (deduplicateBySource) {
      const bySource = new Map<string, SourceMatch>();
      for (const m of matches) {
        const existing = bySource.get(m.source);
        if (!existing || m.matchScore > existing.matchScore) {
          bySource.set(m.source, m);
        }
      }
      matches = Array.from(bySource.values());
    }

    // Sort by matchScore descending
    matches.sort((a, b) => b.matchScore - a.matchScore);

    const best = matches.length > 0 ? matches[0]! : null;

    log.info({
      matches: matches.length,
      best: best ? `${best.source}:${best.title} (${best.matchScore.toFixed(2)})` : 'none',
      duration: Date.now() - startTime,
    }, 'CrossSourceMatcher: complete');

    return {
      query: uniqueTitles[0] || '',
      titles: uniqueTitles,
      matches,
      best,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Single-source match: find the best match for a set of titles in one provider.
   */
  async matchSingle(
    titles: string[],
    provider: SearchProvider,
    minScore = 0.4,
  ): Promise<SourceMatch | null> {
    const result = await this.match(titles, [provider], { minScore, deduplicateBySource: false });
    return result.best;
  }

  /**
   * Dual-similarity scoring for cross-source title matching.
   * Combines Levenshtein (character-level) and word-level matching,
   * taking the maximum of the two approaches.
   *
   * This is more lenient than textSimilarity() because cross-source
   * titles often differ in formatting, punctuation, and word order.
   */
  crossTitleSimilarity(a: string, b: string): number {
    const normA = this.normalizeTitle(a);
    const normB = this.normalizeTitle(b);

    if (!normA || !normB) return 0;
    if (normA === normB) return 1;
    if (normA.includes(normB) || normB.includes(normA)) return 0.95;

    // Use existing Levenshtein-weighted textSimilarity as one signal
    const levBased = textSimilarity(normA, normB);

    // Word-level Jaccard as complementary signal
    const wordsA = new Set(this.getSignificantWords(a));
    const wordsB = this.getSignificantWords(b);
    const common = wordsB.filter(w => wordsA.has(w)).length;
    const maxWords = Math.max(wordsA.size, wordsB.length, 1);
    const wordScore = common / maxWords;

    // Take the better of the two approaches, with slight word-score penalty
    return Math.max(levBased, wordScore * 0.8);
  }

  /**
   * Select best match by result count (chapters, episodes, servers, etc.).
   * Used as tiebreaker when multiple sources have similar match scores.
   */
  selectByResultCount(matches: SourceMatch[], minCount = 20, localBonus = 5): SourceMatch | null {
    if (matches.length === 0) return null;

    const scored = matches.map(m => {
      let score = m.resultCount ?? 0;
      // Bonus for sources with substantial content
      if ((m.resultCount ?? 0) >= minCount) {
        score += localBonus;
      }
      return { ...m, decisionScore: score };
    });

    scored.sort((a, b) => {
      if (b.decisionScore !== a.decisionScore) return b.decisionScore - a.decisionScore;
      return b.matchScore - a.matchScore;
    });

    return scored[0] || null;
  }

  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getSignificantWords(title: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to',
      'for', 'of', 'with', 'by', 'is', 'it', 'as', 'be', 'no', 'not',
      'de', 'la', 'el', 'en', 'y', 'o', 'con', 'por', 'un', 'una',
      'los', 'las', 'del', 'al', 'se', 'su', 'le', 'lo', 'que', 'es',
    ]);
    return this.normalizeTitle(title)
      .split(/\s+/)
      .filter(w => w.length >= 2 && !stopWords.has(w));
  }
}
