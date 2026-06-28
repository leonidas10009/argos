import { getProviderMemory } from '../analysis/ProviderMemory';
import { StaticScraper } from '../analysis/StaticScraper';
import { CircuitBreaker } from '../analysis/CircuitBreaker';
import { getLogger } from '../utils/logger';
import type { EngineName, ProviderConfig, ProviderResult, ScraperConfig } from '../types';
import type { Page } from 'puppeteer';

interface RouterExecuteParams {
  provider: ProviderConfig;
  phase: 'search' | 'videos';
  query?: string;
  pageUrl?: string;
  season?: number;
  episode?: number;
}

export class Router {
  private memory = getProviderMemory();
  private circuitBreaker: CircuitBreaker;

  constructor(circuitBreaker: CircuitBreaker) {
    this.circuitBreaker = circuitBreaker;
  }

  async execute(
    params: RouterExecuteParams,
    dynamicExecutor: ((provider: ProviderConfig, phase: string, params: Record<string, unknown>) => Promise<unknown[]>) | null,
  ): Promise<ProviderResult> {
    const { provider, phase } = params;
    const providerName = provider.name;
    let engineOrder = this.memory.getEngineOrder(providerName);
    const stats = this.memory.getProviderStats(providerName);

    if (!stats || stats.totalAttempts < 3) {
      engineOrder = ['static', 'intelligent', 'dynamic'];
    }

    getLogger().debug({ provider: providerName, phase, order: engineOrder }, 'Router executing');

    let lastResult: unknown[] | null = null;

    for (const engine of engineOrder) {
      const start = Date.now();

      try {
        const result = await this.circuitBreaker.execute(providerName, async () => {
          return this.executeEngine(engine, params, dynamicExecutor);
        });

        const duration = Date.now() - start;
        const success = this.isValidResult(result, phase);

        this.memory.recordEngineAttempt(providerName, engine, phase, success, duration, result.length);

        if (success) {
          return {
            provider: providerName,
            engine,
            phase,
            success: true,
            durationMs: duration,
            results: result,
          };
        }

        lastResult = result;
        getLogger().debug({ provider: providerName, phase, engine }, 'Engine returned no results, falling back');
      } catch (err) {
        const duration = Date.now() - start;
        const errorMsg = (err as Error).message;

        if (errorMsg.includes('Circuit open')) {
          getLogger().warn({ provider: providerName, engine }, 'Circuit open, skipping engine');
        } else {
          this.memory.recordEngineAttempt(providerName, engine, phase, false, duration, 0);
          getLogger().debug({ provider: providerName, engine, error: errorMsg }, 'Engine failed');
        }
      }
    }

    this.memory.recordEngineAttempt(providerName, 'all' as EngineName, phase, false, 0, 0);
    return {
      provider: providerName,
      engine: engineOrder[0],
      phase,
      success: false,
      durationMs: 0,
      results: [],
      error: 'All engines exhausted',
    };
  }

  private async executeEngine(
    engine: EngineName,
    params: RouterExecuteParams,
    dynamicExecutor: ((provider: ProviderConfig, phase: string, params: Record<string, unknown>) => Promise<unknown[]>) | null,
  ): Promise<unknown[]> {
    switch (engine) {
      case 'static':
        return this.executeStatic(params);
      case 'intelligent':
        return this.executeIntelligent(params);
      case 'dynamic':
        if (dynamicExecutor) {
          return dynamicExecutor(params.provider, params.phase, {
            query: params.query,
            pageUrl: params.pageUrl,
            season: params.season,
            episode: params.episode,
          });
        }
        return this.executeIntelligent(params);
      default:
        return [];
    }
  }

  private async executeStatic(params: RouterExecuteParams): Promise<unknown[]> {
    const scraper = new StaticScraper();
    const { provider, phase, query, pageUrl } = params;

    if (phase === 'search' && query && provider.baseUrl) {
      const searchUrl = provider.search.url.replace('{query}', encodeURIComponent(query));
      const fullUrl = searchUrl.startsWith('http') ? searchUrl : provider.baseUrl + searchUrl;
      const result = await scraper.analyze(fullUrl);
      if (result.urlsFound > 0) {
        return result.serverCatalog.map(s => ({ name: s.name, domain: s.domain, urls: s.urls }));
      }
    }

    if (phase === 'videos' && pageUrl) {
      const result = await scraper.analyze(pageUrl);
      if (result.urlsFound > 0) {
        return result.serverCatalog.map(s => ({ name: s.name, domain: s.domain, urls: s.urls }));
      }
    }

    return [];
  }

  private async executeIntelligent(params: RouterExecuteParams): Promise<unknown[]> {
    const scraper = new StaticScraper();
    const { provider, phase, query, pageUrl } = params;

    if (phase === 'search' && query && provider.baseUrl) {
      const searchUrl = provider.search.url.replace('{query}', encodeURIComponent(query));
      const fullUrl = searchUrl.startsWith('http') ? searchUrl : provider.baseUrl + searchUrl;
      const result = await scraper.analyze(fullUrl);
      return result.serverCatalog.map(s => ({ name: s.name, domain: s.domain, urls: s.urls }));
    }

    if (phase === 'videos' && pageUrl) {
      const result = await scraper.analyze(pageUrl);
      return result.serverCatalog.map(s => ({ name: s.name, domain: s.domain, urls: s.urls }));
    }

    return [];
  }

  private isValidResult(result: unknown[], phase: string): boolean {
    if (!result || !Array.isArray(result)) return false;
    return result.length > 0;
  }
}
