import type { SmartScrapeResult, ServerCatalog } from './AutonomousScraper';
import type { ProviderConfig } from '../types';
import type { SiteProfile } from './learning-types';
import { SmartAnalyzer } from './SmartAnalyzer';
import { getLogger } from '../utils/logger';

export class ProfileBuilder {
  private ai = new SmartAnalyzer();

  /**
   * Build a SiteProfile from an autonomous scrape result.
   * Aggregates page types, best selectors, URL patterns, and embed domains discovered.
   */
  buildSiteProfile(result: SmartScrapeResult, domain: string): SiteProfile {
    const pageTypes: SiteProfile['pageTypes'] = {};
    const selectorStats = new Map<string, { successes: number; attempts: number; phase: string }>();
    const urlPatterns: SiteProfile['urlPatterns'] = [];
    const embedDomains = new Set<string>();
    const searchInputs: SiteProfile['searchInputs'] = [];
    let totalResponseTime = 0;
    let responseCount = 0;

    // Aggregate page types from exploration steps
    for (const step of result.steps) {
      const pageUrl = step.target;
      const pageDomain = this.extractDomain(pageUrl);
      if (pageDomain !== domain) continue;

      // Track page type from step reasoning
      const typeMatch = step.reasoning.match(/(listing|detail|content|search)/i);
      if (typeMatch) {
        const pt = typeMatch[1]!.toLowerCase();
        if (!pageTypes[pt]) pageTypes[pt] = { confidence: 0, signals: [], count: 0 };
        pageTypes[pt]!.count++;
      }

      // Track selector success from action results
      if (step.result?.success && step.action === 'navigate') {
        const selector = step.target;
        const existing = selectorStats.get(selector);
        if (existing) {
          existing.successes++;
          existing.attempts++;
        } else {
          selectorStats.set(selector, { successes: 1, attempts: 1, phase: 'navigation' });
        }
      }
      if (step.action === 'group' || step.action === 'dive') {
        const selector = step.target;
        const existing = selectorStats.get(selector);
        if (existing) {
          existing.attempts++;
        } else {
          selectorStats.set(selector, { successes: 1, attempts: 1, phase: step.action });
        }
      }
    }

    // Extract URL patterns from server catalog
    for (const server of result.serverCatalog) {
      for (const entry of server.urls) {
        const pattern = this.extractUrlPattern(entry.url);
        if (pattern) {
          const existing = urlPatterns.find(p => p.pattern === pattern.pattern);
          if (existing) {
            existing.count++;
          } else {
            urlPatterns.push({ ...pattern, count: 1 });
          }
        }

        // Track embed domains
        if (entry.type === 'embed') {
          embedDomains.add(server.domain);
        }
      }
    }

    // Extract search inputs from findings
    if (result.findings) {
      // Look for search-related steps
      const searchSteps = result.steps.filter(s => s.action === 'search');
      for (const step of searchSteps) {
        searchInputs.push({
          selector: step.target,
          placeholder: step.reasoning.replace(/Buscando: "/, '').replace(/"$/, ''),
          method: 'type',
        });
      }
    }

    // Build best selectors
    const bestSelectors: SiteProfile['bestSelectors'] = [];
    for (const [selector, stats] of selectorStats) {
      if (stats.attempts >= 2) {
        bestSelectors.push({
          selector,
          successRate: stats.successes / stats.attempts,
          attempts: stats.attempts,
          phase: stats.phase,
        });
      }
    }
    bestSelectors.sort((a, b) => b.successRate - a.successRate);

    return {
      domain,
      pageTypes,
      bestSelectors: bestSelectors.slice(0, 20),
      urlPatterns: urlPatterns.slice(0, 30),
      embedDomains: [...embedDomains],
      searchInputs,
      avgResponseTime: responseCount > 0 ? totalResponseTime / responseCount : 0,
      visits: 1,
      lastVisit: Date.now(),
      recommendedStrategy: this.recommendStrategy(result, bestSelectors),
    };
  }

  /**
   * Generate a ProviderConfig from a successful scrape result.
   * Infers search URL, item selectors, video extraction type, and episode patterns.
   */
  generateProviderConfig(result: SmartScrapeResult, domain: string, baseUrl: string): ProviderConfig | null {
    const profile = this.buildSiteProfile(result, domain);
    if (profile.bestSelectors.length === 0 && result.serverCatalog.length === 0) return null;

    // Infer search configuration from search steps
    const searchStep = result.steps.find(s => s.action === 'search');
    const searchConfig = searchStep
      ? {
          url: '/search?q={query}',
          itemSelector: this.inferItemSelector(result),
          titleSelector: 'h3, .title, a',
          linkSelector: 'a[href]',
          method: 'GET' as const,
        }
      : {
          url: '/search?q={query}',
          itemSelector: '[class*="card"], [class*="item"]',
          titleSelector: 'h2, h3, .title, a',
          linkSelector: 'a[href]',
          method: 'GET' as const,
        };

    // Infer video extraction type from server catalog
    const videoType = this.inferVideoType(result.serverCatalog);
    const containerSelector = this.inferContainerSelector(result);

    // Infer episode patterns from navigation URLs
    const episodePattern = this.inferEpisodePattern(result);

    return {
      name: domain,
      title: domain.charAt(0).toUpperCase() + domain.slice(1),
      baseUrl,
      language: 'auto',
      categories: ['auto'],
      active: true,
      search: searchConfig,
      episodes: episodePattern
        ? {
            type: 'url' as const,
            pattern: episodePattern,
          }
        : undefined,
      videos: {
        type: videoType,
        containerSelector,
      },
    };
  }

  private recommendStrategy(result: SmartScrapeResult, selectors: SiteProfile['bestSelectors']): SiteProfile['recommendedStrategy'] {
    if (result.durationMs < 10_000 && result.serverCatalog.length > 0) return 'static';
    if (selectors.length > 10 && result.serverCatalog.length > 2) return 'intelligent';
    return 'dynamic';
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
  }

  private extractUrlPattern(url: string): { pattern: string; leadsTo: SiteProfile['urlPatterns'][0]['leadsTo'] } | null {
    try {
      const pathname = new URL(url).pathname;
      const type = this.ai.classifyURL(url, '');

      let pattern = pathname
        .replace(/\/\d+/g, '/{num}')
        .replace(/\/[a-z0-9-]{20,}/g, '/{slug}');

      let leadsTo: SiteProfile['urlPatterns'][0]['leadsTo'] = 'navigation';
      if (type.type === 'embed' || type.type === 'stream') leadsTo = 'servers';
      else if (type.type === 'download') leadsTo = 'download';

      return { pattern, leadsTo };
    } catch {
      return null;
    }
  }

  private inferItemSelector(result: SmartScrapeResult): string {
    // Find repeating CSS classes from exploration steps
    const classCounts = new Map<string, number>();
    for (const step of result.steps) {
      const classes = step.target.match(/\.[a-z][a-z0-9_-]+/g) || [];
      for (const c of classes) classCounts.set(c, (classCounts.get(c) || 0) + 1);
    }
    const sorted = [...classCounts.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, 3).map(([c]) => c).join(', ') || '[class*="item"]';
  }

  private inferVideoType(catalog: ServerCatalog[]): ProviderConfig['videos']['type'] {
    const allTypes = catalog.flatMap(s => s.urls.map(u => u.type));
    const embedCount = allTypes.filter(t => t === 'embed').length;
    const streamCount = allTypes.filter(t => t === 'stream' || t === 'direct-video').length;
    if (streamCount > embedCount) return 'iframe';
    if (embedCount > 0) return 'iframe';
    return 'none';
  }

  private inferContainerSelector(result: SmartScrapeResult): string {
    // Find selectors that led to servers
    const serverSteps = result.steps.filter(s =>
      /server|servidor|player|embed|video|stream/i.test(s.reasoning + s.target)
    );
    if (serverSteps.length > 0) {
      const commonSelectors = serverSteps.map(s => {
        const match = s.target.match(/([.#][a-z][a-z0-9_-]+)/i);
        return match ? match[1]! : '';
      }).filter(Boolean);
      return [...new Set(commonSelectors)].join(', ') || '[class*="player"], [class*="server"]';
    }
    return '[class*="player"], [class*="server"]';
  }

  private inferEpisodePattern(result: SmartScrapeResult): string | null {
    const navUrls = result.findings?.navigationUrls || [];
    const patterns = navUrls
      .map(u => {
        try {
          return new URL(u).pathname
            .replace(/\/\d+/g, '/{num}')
            .replace(/\/[a-z0-9-]{10,}/g, '/{slug}');
        } catch { return null; }
      })
      .filter(Boolean) as string[];

    const counts = new Map<string, number>();
    for (const p of patterns) counts.set(p, (counts.get(p) || 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.length > 0 ? sorted[0]![0]! : null;
  }
}
