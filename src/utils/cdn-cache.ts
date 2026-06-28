import type { Page } from 'puppeteer';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getLogger } from './logger';

export interface CdnCacheEntry {
  url: string;
  localPath: string;
  contentType: string;
  size: number;
  capturedAt: number;
}

/**
 * Captures CDN image/video URLs from network responses and caches them locally.
 * Useful for session-bound CDN URLs that expire quickly (manga readers, video hosts).
 *
 * @example
 * ```ts
 * const cache = new CdnImageCache('./tmp/images');
 * await cache.install(page, (url) => /\.(jpg|png|webp)/i.test(url));
 * await page.goto('https://reader.site/chapter/1');
 * const captured = cache.getCaptured();
 * ```
 */
export class CdnImageCache {
  private outputDir: string;
  private captured: CdnCacheEntry[] = [];
  private handler: ((response: { url: () => string; headers: () => Record<string, string>; buffer: () => Promise<Buffer> }) => Promise<void>) | null = null;
  private filter: (url: string) => boolean;

  constructor(outputDir: string, filter?: (url: string) => boolean) {
    this.outputDir = outputDir;
    this.filter = filter || ((url: string) => /\.(jpg|jpeg|png|webp|gif|bmp|avif)/i.test(url));
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }
  }

  /**
   * Install network response interceptor on a Puppeteer page.
   * Captures matching responses and saves them to disk.
   */
  async install(page: Page): Promise<void> {
    this.handler = async (response) => {
      try {
        const url = response.url();
        if (!this.filter(url)) return;

        const headers = response.headers();
        const contentType = headers['content-type'] || '';
        const buffer = await response.buffer();
        if (buffer.length === 0) return;

        const hash = createHash('md5').update(url).digest('hex').slice(0, 12);
        const ext = this.extractExtension(url, contentType);
        const filename = `${hash}${ext}`;
        const localPath = join(this.outputDir, filename);

        writeFileSync(localPath, buffer);

        this.captured.push({
          url,
          localPath,
          contentType,
          size: buffer.length,
          capturedAt: Date.now(),
        });

        getLogger().debug({ url: url.slice(0, 80), size: buffer.length }, 'CDN cache: captured');
      } catch {
        // Buffer may already be consumed
      }
    };

    page.on('response', this.handler);
  }

  /**
   * Uninstall the interceptor. Call when done with the page.
   */
  uninstall(page: Page): void {
    if (this.handler) {
      page.off('response', this.handler);
      this.handler = null;
    }
  }

  /** Get all captured entries. */
  getCaptured(): CdnCacheEntry[] {
    return [...this.captured];
  }

  /** Get captured URLs only. */
  getUrls(): string[] {
    return this.captured.map(c => c.url);
  }

  /** Get local file paths. */
  getLocalPaths(): string[] {
    return this.captured.map(c => c.localPath);
  }

  /**
   * Progressive batch loading support for manga readers.
   * Provides a subset of cached images for lazy loading.
   */
  getBatch(offset: number, batchSize: number): CdnCacheEntry[] {
    return this.captured.slice(offset, offset + batchSize);
  }

  /** Total number of cached files. */
  get count(): number {
    return this.captured.length;
  }

  /** Clear cache (both memory and disk). */
  clear(): void {
    this.captured = [];
  }

  private extractExtension(url: string, contentType: string): string {
    const urlMatch = url.match(/\.([a-z0-9]{3,5})(\?|$)/i);
    if (urlMatch) return '.' + urlMatch[1]!.toLowerCase();

    const mimeMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/avif': '.avif',
      'image/bmp': '.bmp',
      'video/mp4': '.mp4',
    };
    return mimeMap[contentType] || '.bin';
  }
}
