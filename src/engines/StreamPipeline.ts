import { CircuitBreaker } from '../analysis/CircuitBreaker';
import { EmbedResolver } from '../analysis/EmbedResolver';
import { StreamNormalizer } from '../analysis/StreamNormalizer';
import type { StreamInfo } from '../types';
import { getLogger } from '../utils/logger';

interface PipelineProvider {
  name: string;
  execute(phase: 'search' | 'videos', params: Record<string, unknown>): Promise<unknown[]>;
}

interface PipelineOptions {
  concurrency: number;
  perProviderTimeoutMs: number;
  globalTimeoutMs: number;
  maxResults: number;
  resolveEmbeds: boolean;
}

const DEFAULT_OPTIONS: PipelineOptions = {
  concurrency: 8,
  perProviderTimeoutMs: 30_000,
  globalTimeoutMs: 45_000,
  maxResults: 50,
  resolveEmbeds: true,
};

export class StreamPipeline {
  private circuitBreaker: CircuitBreaker;
  private embedResolver: EmbedResolver;
  private normalizer: StreamNormalizer;
  private options: PipelineOptions;

  constructor(
    circuitBreaker: CircuitBreaker,
    options?: Partial<PipelineOptions>,
  ) {
    this.circuitBreaker = circuitBreaker;
    this.embedResolver = new EmbedResolver();
    this.normalizer = new StreamNormalizer();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async execute(
    providers: PipelineProvider[],
    phase: 'search' | 'videos',
    params: Record<string, unknown>,
  ): Promise<StreamInfo[]> {
    const log = getLogger();
    const globalStart = Date.now();
    const rawResults: { provider: string; results: unknown[] }[] = [];

    const activeProviders = providers.filter(() => true);
    const chunks = this.chunk(activeProviders, this.options.concurrency);

    for (const chunk of chunks) {
      if (Date.now() - globalStart > this.options.globalTimeoutMs) {
        log.warn('Pipeline global timeout reached, returning partial results');
        break;
      }

      const settled = await Promise.allSettled(
        chunk.map(p => this.executeProvider(p, phase, params)),
      );

      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0) {
          rawResults.push({ provider: chunk[i].name, results: r.value });
        }
      }
    }

    // Flatten to StreamInfo
    const streams: StreamInfo[] = [];
    for (const { provider, results } of rawResults) {
      for (const item of results) {
        if (typeof item === 'string') {
          streams.push(this.normalizer.normalize(item, [provider]));
        } else if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          const url = (obj.url || obj.href || obj.src || '') as string;
          if (url) {
            const labels = [provider, (obj.name || obj.title || '') as string];
            streams.push(this.normalizer.normalize(url, labels));
          }
        }
      }
    }

    // Resolve embeds to direct URLs
    if (this.options.resolveEmbeds) {
      const embedUrls = streams
        .filter(s => s.type === 'embed')
        .map(s => s.url);
      if (embedUrls.length > 0) {
        const resolved = await this.embedResolver.resolveAll(
          embedUrls.slice(0, 10),
          undefined,
          4,
        );
        for (const stream of streams) {
          const found = resolved.find(r => r.embedUrl === stream.url);
          if (found?.directUrl) {
            stream.directUrl = found.directUrl;
            stream.type = this.embedResolver.isDirectVideoUrl(found.directUrl) ? 'mp4' : 'm3u8';
          }
        }
      }
    }

    // Deduplicate by URL fingerprint
    const seen = new Set<string>();
    const deduped = streams.filter(s => {
      const fp = `${s.url.replace(/[?#].*/, '')}|${s.serverName}`;
      if (seen.has(fp)) return false;
      seen.add(fp);
      return true;
    });

    // Sort by priority
    const sorted = this.normalizer.sortByPriority(deduped);

    log.info({
      providers: providers.length,
      results: sorted.length,
      duration: Date.now() - globalStart,
    }, 'Pipeline complete');

    return sorted.slice(0, this.options.maxResults);
  }

  async executeSingle(
    provider: PipelineProvider,
    phase: 'search' | 'videos',
    params: Record<string, unknown>,
  ): Promise<StreamInfo[]> {
    return this.execute([provider], phase, params);
  }

  private async executeProvider(
    provider: PipelineProvider,
    phase: string,
    params: Record<string, unknown>,
  ): Promise<unknown[]> {
    if (this.circuitBreaker.shouldSkip(provider.name)) {
      getLogger().debug({ provider: provider.name }, 'Circuit open, skipping');
      return [];
    }

    try {
      const results = await Promise.race([
        provider.execute(phase as 'search' | 'videos', params),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Provider ${provider.name} timed out`)),
            this.options.perProviderTimeoutMs,
          ),
        ),
      ]);

      this.circuitBreaker.recordSuccess(provider.name);
      return Array.isArray(results) ? results : [];
    } catch (err) {
      this.circuitBreaker.recordFailure(provider.name);
      getLogger().debug({
        provider: provider.name,
        error: (err as Error).message,
      }, 'Provider failed');
      return [];
    }
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }
}
