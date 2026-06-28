import type { Page } from 'puppeteer';
import type { CheerioAPI } from 'cheerio';

export interface LazyImageCandidate {
  selector: string;
  attributes: {
    src?: string;
    lazyUrl?: string;
    coverUrl?: string;
    dataSrc?: string;
    dataOriginal?: string;
    dataLazySrc?: string;
    srcset?: string;
    dataSrcset?: string;
    backgroundImage?: string;
  };
  isPlaceholder: boolean;
  resolvedUrl: string | null;
}

export interface LazyResolveOptions {
  maxImages?: number;
  skipPlaceholders?: boolean;
  includeBackgroundImages?: boolean;
  forceLoad?: boolean;
}

const DEFAULT_PLACEHOLDERS = [
  '/files/images/default/', '/images/default/', 'placeholder',
  'blank', 'transparent', '1x1', 'spacer', 'no-image', 'no_photo',
  'default_cover', 'default_pic', 'notfound', 'noimage',
];

export class LazyImageResolver {
  async extractFromPage(page: Page, options: LazyResolveOptions = {}): Promise<LazyImageCandidate[]> {
    const { skipPlaceholders = true, includeBackgroundImages = true } = options;

    return await page.evaluate(({ skip, bg, placeholders }) => {
      const candidates: LazyImageCandidate[] = [];
      const seen = new Set<string>();

      document.querySelectorAll('img').forEach((img, idx) => {
        const src = img.getAttribute('src') || '';
        const lazyUrl = img.getAttribute('lazy_url') || '';
        const coverUrl = img.getAttribute('cover_url') || '';
        const dataSrc = img.getAttribute('data-src') || '';
        const dataOriginal = img.getAttribute('data-original') || '';
        const dataLazySrc = img.getAttribute('data-lazy-src') || '';
        const srcset = img.getAttribute('srcset') || '';
        const dataSrcset = img.getAttribute('data-srcset') || '';

        const isPlaceholder = placeholders.some((p: string) =>
          [src, lazyUrl, coverUrl, dataSrc, dataOriginal].some(v => v.toLowerCase().includes(p))
        );

        let resolved: string | null = null;
        if (coverUrl && coverUrl.startsWith('http')) resolved = coverUrl;
        else if (dataOriginal && dataOriginal.startsWith('http')) resolved = dataOriginal;
        else if (dataSrc && dataSrc.startsWith('http')) resolved = dataSrc;
        else if (lazyUrl && lazyUrl.startsWith('http')) resolved = lazyUrl;
        else if (dataLazySrc && dataLazySrc.startsWith('http')) resolved = dataLazySrc;
        else if (src && src.startsWith('http') && !isPlaceholder) resolved = src;

        if (skip && isPlaceholder && !resolved) return;
        if (resolved && seen.has(resolved)) return;
        if (resolved) seen.add(resolved);

        candidates.push({
          selector: img.id ? '#' + img.id : 'img:nth-of-type(' + (idx + 1) + ')',
          attributes: { src, lazyUrl, coverUrl, dataSrc, dataOriginal, dataLazySrc, srcset, dataSrcset },
          isPlaceholder,
          resolvedUrl: resolved,
        });
      });

      if (bg) {
        document.querySelectorAll('div[style*="background"], div[class*="bg-"]').forEach((div, idx) => {
          const style = div.getAttribute('style') || '';
          const bgMatch = style.match(/background(?:-image)?\s*:\s*url\(["']?([^"')]+)["']?\)/i);
          if (bgMatch) {
            const url = bgMatch[1];
            const isPH = placeholders.some((p: string) => url.toLowerCase().includes(p));
            if (skip && isPH) return;
            candidates.push({
              selector: 'div:nth-of-type(' + (idx + 1) + ')',
              attributes: { backgroundImage: url },
              isPlaceholder: isPH,
              resolvedUrl: url.startsWith('http') ? url : null,
            });
          }
        });
      }

      return candidates;
    }, { skip: skipPlaceholders, bg: includeBackgroundImages, placeholders: DEFAULT_PLACEHOLDERS });
  }

  async forceLoad(page: Page): Promise<number> {
    return await page.evaluate(() => {
      let count = 0;

      document.querySelectorAll('img').forEach(img => {
        const real = img.getAttribute('cover_url') || img.getAttribute('data-original')
          || img.getAttribute('data-src') || img.getAttribute('lazy_url')
          || img.getAttribute('data-lazy-src');

        if (real && real.startsWith('http') && real !== img.src) {
          img.setAttribute('src', real);
          count++;
        }

        if (img.getAttribute('loading') === 'lazy') {
          img.setAttribute('loading', 'eager');
          count++;
        }
      });

      document.querySelectorAll('.lazy-hidden, .lazyload, [class*="lazy"]').forEach(el => {
        (el as HTMLElement).style.display = '';
        (el as HTMLElement).style.visibility = 'visible';
        count++;
      });

      return count;
    });
  }

  extractFromCheerio($: CheerioAPI, options: LazyResolveOptions = {}): LazyImageCandidate[] {
    const { skipPlaceholders = true } = options;
    const candidates: LazyImageCandidate[] = [];
    const seen = new Set<string>();

    $('img').each((idx, el) => {
      const $el = $(el);
      const src = $el.attr('src') || '';
      const lazyUrl = $el.attr('lazy_url') || '';
      const coverUrl = $el.attr('cover_url') || '';
      const dataSrc = $el.attr('data-src') || '';
      const dataOriginal = $el.attr('data-original') || '';

      const isPlaceholder = DEFAULT_PLACEHOLDERS.some(p =>
        [src, lazyUrl, coverUrl, dataSrc].some(v => v.toLowerCase().includes(p))
      );

      let resolved: string | null = null;
      if (coverUrl && coverUrl.startsWith('http')) resolved = coverUrl;
      else if (dataOriginal && dataOriginal.startsWith('http')) resolved = dataOriginal;
      else if (dataSrc && dataSrc.startsWith('http')) resolved = dataSrc;
      else if (lazyUrl && lazyUrl.startsWith('http')) resolved = lazyUrl;
      else if (src && src.startsWith('http') && !isPlaceholder) resolved = src;

      if (skipPlaceholders && isPlaceholder && !resolved) return;
      if (resolved && seen.has(resolved)) return;
      if (resolved) seen.add(resolved);

      candidates.push({
        selector: `img:nth-of-type(${idx + 1})`,
        attributes: { src, lazyUrl, coverUrl, dataSrc, dataOriginal },
        isPlaceholder,
        resolvedUrl: resolved,
      });
    });

    return candidates;
  }
}
