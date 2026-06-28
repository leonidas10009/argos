import { BrowserPool } from './browser/BrowserPool';
import { createBrowser, createPage } from './browser/launcher';
import { setupResourceBlocking } from './browser/ResourceBlocker';
import { AutonomousScraper, AutonomousScraperOptions } from './analysis/AutonomousScraper';
import { StaticScraper } from './analysis/StaticScraper';
import { EmbedResolver } from './analysis/EmbedResolver';
import { CircuitBreaker } from './analysis/CircuitBreaker';
import { MemoryWatchdog } from './analysis/MemoryWatchdog';
import { StreamNormalizer } from './analysis/StreamNormalizer';
import { ProviderRegistry, getProviderRegistry } from './analysis/ProviderRegistry';
import { getProviderMemory } from './analysis/ProviderMemory';
import { HealthMonitor, getHealthMonitor } from './analysis/HealthMonitor';
import { ProfileExporter } from './analysis/ProfileExporter';
import { ProfileBuilder } from './analysis/ProfileBuilder';
import { getLearnedKB } from './analysis/LearnedKnowledgeBase';
import { PageInteractions } from './interactions/PageInteractions';
import { ProxyRotator } from './proxy/ProxyRotator';
import { cheerioStrategy, iframeStrategy, puppeteerStrategy } from './strategies';
import { Router } from './engines/Router';
import { retry } from './utils/retry';
import { takeScreenshot } from './utils/screenshot';
import { createLogger, getLogger } from './utils/logger';
import { loadConfig } from './config';
import { extractServers } from './extractors/ServerListExtractor';
import { ProviderNotFoundError } from './utils/errors';
import type {
  ScraperConfig,
  ScrapeTarget,
  ScrapeResult,
  StrategyName,
  ServerEntry,
  ProviderConfig,
  HealthReport,
  ProviderResult,
  EmbedResult,
  StreamInfo,
  CircuitState,
} from './types';
import type { BrowserInstance } from './types';
import type { SmartScrapeResult } from './analysis/AutonomousScraper';
import type { ExportableProfile } from './analysis/learning-types';
import type { Page } from 'puppeteer';

export class ScraperEngine {
  private config: ScraperConfig;
  private pool: BrowserPool | null = null;
  private proxyRotator: ProxyRotator;
  private embedResolver: EmbedResolver;
  private circuitBreaker: CircuitBreaker;
  private memoryWatchdog: MemoryWatchdog;
  private streamNormalizer: StreamNormalizer;
  private router: Router;
  private providerRegistry: ProviderRegistry;
  private healthMonitor: HealthMonitor;
  private profileExporter: ProfileExporter;

  constructor(overrides?: Partial<ScraperConfig>) {
    this.config = loadConfig(overrides);
    createLogger(this.config.logLevel);
    this.proxyRotator = new ProxyRotator(this.config.proxy.list);
    this.embedResolver = new EmbedResolver();
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreaker.failureThreshold,
      this.config.circuitBreaker.resetTimeoutMs,
      this.config.circuitBreaker.halfOpenMax,
    );
    this.memoryWatchdog = new MemoryWatchdog({
      warningPercent: this.config.memoryWatchdog.warningPercent,
      criticalPercent: this.config.memoryWatchdog.criticalPercent,
      checkIntervalMs: this.config.memoryWatchdog.checkIntervalMs,
    });
    this.streamNormalizer = new StreamNormalizer();
    this.router = new Router(this.circuitBreaker);
    this.providerRegistry = getProviderRegistry();
    this.healthMonitor = getHealthMonitor();
    this.profileExporter = new ProfileExporter();
  }

  /**
   * Initialize the engine — creates browser pool, starts memory watchdog.
   * Must be called before any scrape operation.
   */
  async initialize(): Promise<void> {
    const log = getLogger();
    log.info('Initializing ScraperEngine v3.2');

    this.pool = new BrowserPool(
      () => createBrowser(this.config),
      this.config.browserPool,
    );

    if (this.config.browserPool.min > 0) {
      const instance = await this.pool.acquire();
      await this.pool.release(instance);
      log.info('Initial browser instance warmed up');
    }

    this.memoryWatchdog.registerCache('embedResolver', () => this.embedResolver.clearCache());

    if (this.config.memoryWatchdog.enabled) {
      this.memoryWatchdog.start();
    }

    log.info({
      strategies: this.config.strategies,
      providers: this.providerRegistry.count(),
      deadlineMs: this.config.streamDeadlineMs,
    }, 'ScraperEngine ready');
  }

  /**
   * Scrape a single URL using the configured strategy cascade (Cheerio → Iframe → Puppeteer).
   * @param target - URL and optional selectors/timeouts
   * @returns ScrapeResult with success flag, data, strategy used, and duration
   */
  async scrape(target: ScrapeTarget): Promise<ScrapeResult> {
    const log = getLogger();
    const startTime = Date.now();

    log.info({ url: target.url }, 'Starting scrape');

    const result = await retry(
      async () => this.executeStrategies(target),
      {
        maxRetries: this.config.retry.maxRetries,
        delayMs: this.config.retry.delayMs,
      },
    );

    const duration = Date.now() - startTime;
    log.info({ url: target.url, success: result.success, duration, strategy: result.strategy }, 'Scrape completed');

    return {
      ...result,
      url: target.url,
      durationMs: duration,
    };
  }

  /** Scrape multiple URLs concurrently using bounded worker pool. */
  async scrapeMultiple(targets: ScrapeTarget[]): Promise<ScrapeResult[]> {
    const log = getLogger();
    log.info({ count: targets.length }, 'Starting concurrent scrape');

    const concurrency = Math.min(this.config.concurrency.max, targets.length);
    const results: ScrapeResult[] = [];
    const queue = [...targets];
    const workers: Promise<void>[] = [];

    for (let i = 0; i < concurrency; i++) {
      workers.push(this.worker(queue, results));
    }

    await Promise.all(workers);
    return results;
  }

  async extract(target: ScrapeTarget): Promise<ServerEntry[]> {
    const result = await this.scrape(target);
    return extractServers(result);
  }

  async extractMultiple(targets: ScrapeTarget[]): Promise<ServerEntry[]> {
    const results = await this.scrapeMultiple(targets);
    return results.flatMap(extractServers);
  }

  getConfig(): ScraperConfig {
    return { ...this.config };
  }

  setProxy(proxies: string[]): void {
    this.config.proxy.list = proxies;
    this.proxyRotator = new ProxyRotator(proxies);
    getLogger().info({ count: proxies.length }, 'Proxies updated');
  }

  getStats() {
    if (!this.pool) return null;
    return this.pool.getStats();
  }

  getCircuitStates(): CircuitState[] {
    return this.circuitBreaker.getAllStates();
  }

  getHealthReport(): HealthReport[] {
    const memory = getProviderMemory();
    const stats = memory.getAllStats();
    return stats.map(s => ({
      provider: s.name,
      status: s.successRate >= 60 ? 'healthy' : s.successRate >= 30 ? 'degraded' : 'failed',
      uptime: Date.now() - 0,
      attempts: s.totalAttempts,
      successRate: s.successRate,
      circuitState: this.circuitBreaker.getState(s.name).state,
      lastCheck: Date.now(),
    }));
  }

  getHealthSummary() {
    return this.healthMonitor.getSummary();
  }

  getProviderScore(providerName: string) {
    return this.healthMonitor.getProviderScore(providerName);
  }

  /**
   * Quick single-page scrape — no recursion, ~8-30s. Clicks server buttons
   * and captures network responses on the current page only.
   * @returns SmartScrapeResult with 30s deadline
   */
  async quickScrape(url: string, options?: AutonomousScraperOptions) {
    if (!this.pool) throw new Error('Engine not initialized. Call initialize() first.');

    const log = getLogger();
    const instance = await this.pool.acquire();
    const page = await createPage(instance.browser, this.config);

    if (this.config.blockResources) {
      await setupResourceBlocking(page);
    }

    try {
      const scraper = new AutonomousScraper(page, {
        deadlineMs: 30_000,
        ...options,
      });
      return await scraper.quickInvestigate(url);
    } catch (err) {
      log.error({ url, error: (err as Error).message }, 'Quick scrape failed');
      throw err;
    } finally {
      try { await page.close(); } catch { /* page ya cerrada */ }
      await this.pool.release(instance);
    }
  }

  async resolveEmbeds(urls: string[], referer?: string): Promise<EmbedResult[]> {
    return this.embedResolver.resolveAll(urls, referer);
  }

  /**
   * Resolve an embed/hoster URL to a direct video URL (m3u8/mp4).
   * Supports 15+ domains: streamwish, filemoon, doodstream, mixdrop, voe, streamtape...
   */
  async resolveEmbed(url: string, referer?: string): Promise<EmbedResult> {
    return this.embedResolver.resolve(url, referer);
  }

  normalizeStream(url: string, labels?: string[]): StreamInfo {
    return this.streamNormalizer.normalize(url, labels);
  }

  normalizeStreams(urls: string[], labels?: string[]): StreamInfo[] {
    return this.streamNormalizer.normalizeBatch(urls, labels);
  }

  registerProvider(config: ProviderConfig): void {
    this.providerRegistry.register(config);
    getLogger().info({ provider: config.name }, 'Provider registered');
  }

  unregisterProvider(name: string): boolean {
    const result = this.providerRegistry.unregister(name);
    if (result) getLogger().info({ provider: name }, 'Provider unregistered');
    return result;
  }

  getProviders(): ProviderConfig[] {
    return this.providerRegistry.getActive();
  }

  /** Export all learned profiles, providers, navigation maps, and KB to portable JSON. */
  exportProfile(path?: string): ExportableProfile {
    const profile = this.profileExporter.export();
    if (path) this.profileExporter.saveToFile(path);
    return profile;
  }

  /** Import a previously exported profile (providers, site profiles, KB). */
  importProfile(data: ExportableProfile): void {
    this.profileExporter.import(data);
    // Register imported providers
    for (const p of data.providers || []) {
      this.providerRegistry.register(p);
    }
  }

  /** Load profile from a JSON file. */
  loadProfile(path: string): boolean {
    return this.profileExporter.loadFromFile(path);
  }

  /** Get site profile learned for a domain. */
  getSiteProfile(domain: string) {
    return this.profileExporter.getProfile(domain);
  }

  /** Get navigation map learned for a domain. */
  getNavigationMap(domain: string) {
    return this.profileExporter.getNavigationMap(domain);
  }

  /** Generate a ProviderConfig from a scrape result. */
  generateProviderConfig(result: SmartScrapeResult, domain: string, baseUrl: string) {
    return new ProfileBuilder().generateProviderConfig(result, domain, baseUrl);
  }

  /** Get the learned knowledge base (organic domain discoveries). */
  getLearnedKnowledgeBase() {
    return getLearnedKB().getData();
  }

  async executeProvider(
    providerName: string,
    phase: 'search' | 'videos',
    params: { query?: string; pageUrl?: string; season?: number; episode?: number },
  ): Promise<ProviderResult> {
    const provider = this.providerRegistry.get(providerName);
    if (!provider) {
      throw new ProviderNotFoundError(providerName);
    }
    return this.router.execute(
      { provider, phase, ...params },
      null,
    );
  }

  async withPage<T>(url: string, fn: (interactions: PageInteractions) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('Engine not initialized. Call initialize() first.');

    const instance = await this.pool.acquire();
    const page = await createPage(instance.browser, this.config);

    if (this.config.blockResources) {
      await setupResourceBlocking(page);
    }

    const interactions = new PageInteractions(page, this.config.timeouts.page);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeouts.page });
      return await fn(interactions);
    } finally {
      await page.close();
      await this.pool.release(instance);
    }
  }

  /**
   * Autonomous intelligent scrape — depth-first recursive exploration.
   * Uses Puppeteer browser to navigate, build semantic models, click elements,
   * and extract server catalogs without any hardcoded selectors.
   *
   * @param url - Target URL to explore
   * @param options.searchTerm - Primary search query if the page has a search input
   * @param options.searchTerms - Fallback search terms for progressive matching
   * @param options.contentGoal - Content type to prioritize (video, manga, image, download, document, auto)
   * @param options.maxRequests - Max HTTP requests per session (default 50)
   * @param options.deadlineMs - Hard deadline; returns partial results if exceeded (default 45s)
   * @param options.debug - Enable visual debug reports with screenshots
   * @returns SmartScrapeResult with serverCatalog, streams (priority-sorted), findings, and partial flag
   */
  async autonomousScrape(url: string, options?: AutonomousScraperOptions) {
    if (!this.pool) throw new Error('Engine not initialized. Call initialize() first.');

    const log = getLogger();
    const instance = await this.pool.acquire();
    const page = await createPage(instance.browser, this.config);

    if (this.config.blockResources) {
      await setupResourceBlocking(page);
    }

    const effectiveOptions: AutonomousScraperOptions = {
      deadlineMs: this.config.streamDeadlineMs,
      ...options,
    };

    try {
      const scraper = new AutonomousScraper(page, effectiveOptions);
      const result = await this.circuitBreaker.execute(
        new URL(url).hostname,
        () => scraper.investigate(url),
      );

      if (result.serverCatalog.length > 0) {
        const embedUrls = result.serverCatalog.flatMap(s => s.urls.map(u => u.url));
        const resolved = await this.resolveEmbeds(embedUrls, url);

        for (const server of result.serverCatalog) {
          for (const entry of server.urls) {
            const found = resolved.find(r => r.embedUrl === entry.url);
            if (found?.directUrl) {
              entry.directUrl = found.directUrl;
            }
          }
        }

        const enrichedStreams: StreamInfo[] = [];
        for (const server of result.serverCatalog) {
          for (const entry of server.urls) {
            const info = this.streamNormalizer.enrichWithEmbed(
              entry.url,
              entry.directUrl || null,
              [entry.label, server.name, entry.type],
            );
            enrichedStreams.push(info);
          }
        }
        result.streams = this.streamNormalizer.sortByPriority(
          this.streamNormalizer.deduplicate(enrichedStreams),
        );
      }

      // Auto-learning: feed results to ProfileExporter for future sessions
      try {
        const domain = new URL(url).hostname;
        this.profileExporter.processResult(result, domain, url);
      } catch { /* non-critical */ }

      return result;
    } catch (err) {
      log.error({ url, error: (err as Error).message }, 'Autonomous scrape failed');
      throw err;
    } finally {
      try { await page.close(); } catch { /* page ya cerrada */ }
      await this.pool.release(instance);
    }
  }

  async staticAnalyze(url: string) {
    const scraper = new StaticScraper();
    return scraper.analyze(url);
  }

  async shutdown(): Promise<void> {
    const log = getLogger();
    log.info('Shutting down ScraperEngine');
    this.memoryWatchdog.stop();
    getProviderMemory().forceSave();
    if (this.pool) {
      await this.pool.closeAll();
      this.pool = null;
    }
  }

  private async worker(queue: ScrapeTarget[], results: ScrapeResult[]): Promise<void> {
    while (queue.length > 0) {
      const target = queue.shift();
      if (!target) break;
      try {
        const result = await this.scrape(target);
        results.push(result);
      } catch (err) {
        results.push({
          url: target.url,
          strategy: 'cheerio',
          success: false,
          data: null,
          durationMs: 0,
          error: (err as Error).message,
          retries: this.config.retry.maxRetries,
        });
      }
    }
  }

  private async executeStrategies(target: ScrapeTarget): Promise<ScrapeResult> {
    const log = getLogger();

    for (const strategy of this.config.strategies) {
      if (strategy === 'cheerio') {
        const result = await cheerioStrategy({ url: target.url });
        if (result.success && this.hasServerData(result.data)) {
          return { ...result, url: target.url, durationMs: 0, retries: 0 };
        }
        log.debug('Cheerio: no server data, falling back');
        continue;
      }

      if (strategy === 'iframe' || strategy === 'puppeteer') {
        const instance = await this.pool!.acquire();
        const page = await createPage(instance.browser, this.config);

        if (this.config.blockResources) {
          await setupResourceBlocking(page);
        }

        try {
          if (strategy === 'iframe') {
            await page.goto(target.url, {
              waitUntil: 'domcontentloaded',
              timeout: this.config.timeouts.page,
            });

            const result = await iframeStrategy({ url: target.url, page });
            if (result.success && this.hasServerData(result.data)) {
              return { ...result, url: target.url, durationMs: 0, retries: 0 };
            }
          }

          if (strategy === 'puppeteer') {
            const result = await puppeteerStrategy(
              { url: target.url, page },
              this.config,
              page,
              instance.browser,
            );

            if (result.success && this.hasServerData(result.data)) {
              return { ...result, url: target.url, durationMs: 0, retries: 0 };
            }

            if (!result.success && this.config.screenshots.enabled) {
              await takeScreenshot(page, this.config.screenshots.dir, 'error');
            }
          }
        } finally {
          await page.close();
          await this.pool!.release(instance);
        }
      }
    }

    return {
      url: target.url,
      strategy: this.config.strategies[this.config.strategies.length - 1] || 'cheerio',
      success: false,
      data: null,
      durationMs: 0,
      error: 'All strategies failed',
      retries: 0,
    };
  }

  private hasServerData(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const servers = (data as Record<string, unknown>)['servers'];
    return Array.isArray(servers) && servers.length > 0;
  }
}
