import type { CheerioAPI } from 'cheerio';
import { getLogger } from '../utils/logger';

export type PaginationPattern = 'suffix-counter' | 'query-param' | 'path-segment' | 'none';

export interface PaginationDetection {
  pattern: PaginationPattern;
  baseUrl: string;
  currentPage: number;
  totalPages: number | null;
  pageUrlTemplate: string;
}

export interface PageFetchResult<T> {
  pageNumber: number;
  url: string;
  items: T[];
  error?: string;
  durationMs: number;
}

export interface PaginatedScrapeResult<T> {
  baseUrl: string;
  pagination: PaginationDetection;
  totalItems: number;
  pagesFetched: number;
  pagesFailed: number;
  items: T[];
  pageResults: PageFetchResult<T>[];
  durationMs: number;
}

export interface PaginatedScrapeOptions<T> {
  maxConcurrency?: number;
  rateLimitMs?: number;
  maxPages?: number;
  autoDiscoverPages?: boolean;
  itemExtractor: ($: CheerioAPI, url: string) => T[];
  fetchPage: (url: string) => Promise<string>;
}

export class PaginatedCategoryScraper {
  detectPattern(url: string, body?: string): PaginationDetection {
    const suffixMatch = url.match(/^(.+?)(?:_(\d+))?\.html$/i);
    if (suffixMatch) {
      const base = suffixMatch[1] + '.html';
      return {
        pattern: 'suffix-counter',
        baseUrl: suffixMatch[2] ? new URL(base, url).href : url,
        currentPage: parseInt(suffixMatch[2] || '1'),
        totalPages: this.extractTotalPages(body, 'suffix-counter'),
        pageUrlTemplate: suffixMatch[1] + '_{page}.html',
      };
    }

    const qpMatch = url.match(/[?&]page=(\d+)/i);
    if (qpMatch) {
      const base = url.replace(/[?&]page=\d+/i, '').replace(/[?&]$/, '');
      return {
        pattern: 'query-param',
        baseUrl: base,
        currentPage: parseInt(qpMatch[1]),
        totalPages: this.extractTotalPages(body, 'query-param'),
        pageUrlTemplate: base + (base.includes('?') ? '&page={page}' : '?page={page}'),
      };
    }

    const psMatch = url.match(/\/page\/(\d+)/i);
    if (psMatch) {
      const base = url.replace(/\/page\/\d+/i, '');
      return {
        pattern: 'path-segment',
        baseUrl: base,
        currentPage: parseInt(psMatch[1]),
        totalPages: this.extractTotalPages(body, 'path-segment'),
        pageUrlTemplate: base + '/page/{page}/',
      };
    }

    return { pattern: 'none', baseUrl: url, currentPage: 1, totalPages: 1, pageUrlTemplate: url };
  }

  buildPageUrl(detection: PaginationDetection, pageNum: number): string {
    return detection.pageUrlTemplate.replace('{page}', String(pageNum));
  }

  async scrapeAll<T>(startUrl: string, options: PaginatedScrapeOptions<T>): Promise<PaginatedScrapeResult<T>> {
    const {
      maxConcurrency = 3, rateLimitMs = 800, maxPages = 50,
      autoDiscoverPages = true, itemExtractor, fetchPage,
    } = options;

    const startTime = Date.now();
    let detection: PaginationDetection;
    let firstBody = '';

    try {
      firstBody = await fetchPage(startUrl);
      detection = this.detectPattern(startUrl, autoDiscoverPages ? firstBody : undefined);
    } catch {
      detection = this.detectPattern(startUrl);
    }

    const totalToFetch = detection.totalPages
      ? Math.min(detection.totalPages, maxPages)
      : maxPages;

    const pageUrls: { num: number; url: string }[] = [];
    for (let p = 1; p <= totalToFetch; p++) {
      pageUrls.push({ num: p, url: this.buildPageUrl(detection, p) });
    }

    getLogger().info({ pages: pageUrls.length, pattern: detection.pattern }, 'PaginatedCategoryScraper: starting');

    const results: PageFetchResult<T>[] = [];

    for (let i = 0; i < pageUrls.length; i += maxConcurrency) {
      const batch = pageUrls.slice(i, i + maxConcurrency);

      const batchResults = await Promise.allSettled(
        batch.map(async ({ num, url }) => {
          const ps = Date.now();
          try {
            const body = await fetchPage(url);
            const cheerio = await import('cheerio');
            const $ = cheerio.load(body);
            const items = itemExtractor($, url);
            return { pageNumber: num, url, items, durationMs: Date.now() - ps } as PageFetchResult<T>;
          } catch (err) {
            return {
              pageNumber: num, url, items: [],
              error: err instanceof Error ? err.message : String(err),
              durationMs: Date.now() - ps,
            } as PageFetchResult<T>;
          }
        }),
      );

      for (const r of batchResults) {
        if (r.status === 'fulfilled') results.push(r.value);
        else results.push({ pageNumber: 0, url: '', items: [], error: 'Batch promise rejected', durationMs: 0 });
      }

      if (i + maxConcurrency < pageUrls.length) {
        await new Promise(r => setTimeout(r, rateLimitMs));
      }
    }

    const allItems = results.flatMap(r => r.items);
    const failed = results.filter(r => r.error).length;

    return {
      baseUrl: detection.baseUrl,
      pagination: detection,
      totalItems: allItems.length,
      pagesFetched: results.length - failed,
      pagesFailed: failed,
      items: allItems,
      pageResults: results,
      durationMs: Date.now() - startTime,
    };
  }

  private extractTotalPages(body: string | undefined, pattern: PaginationPattern): number | null {
    if (!body) return null;

    if (pattern === 'suffix-counter') {
      const matches = [...body.matchAll(/_(\d+)\.html/gi)].map(m => parseInt(m[1]));
      if (matches.length > 0) return Math.max(...matches);
    }

    const pagTexts = [...body.matchAll(/pagina\s*(\d+)\s*(?:de|of|\/)\s*(\d+)/gi)];
    for (const m of pagTexts) {
      return parseInt(m[2]);
    }

    return null;
  }
}
