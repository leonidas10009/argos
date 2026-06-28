import type { Page } from 'puppeteer';
import { PageTypeClassifier, type PageAnalysis } from './PageTypeClassifier';
import type { RawElement } from './types';

export interface SitePageType {
  name: string;
  signals: string[];
  confidence: number;
}

export interface SiteIdentifiers {
  slug?: string;
  id?: string;
  title?: string;
}

export interface SitePageAnalysis extends PageAnalysis {
  siteType: string;
  identifiers: SiteIdentifiers;
  isProtected: boolean;
  paginationDetected: boolean;
}

export interface UrlPatterns {
  [key: string]: RegExp;
}

/**
 * Base class for site-specific page analysis adapters.
 * Extend this to add domain knowledge for a specific website:
 * URL patterns, page type detection, identifier extraction, pagination detection.
 *
 * @example
 * ```ts
 * class MySiteAdapter extends BaseSiteAdapter {
 *   urlPatterns = {
 *     detail: /^\/manga\//,
 *     chapter: /^\/chapter\//,
 *   };
 *
 *   detectSiteType(url: string, elements: RawElement[]): SitePageType {
 *     if (this.urlPatterns.chapter.test(url)) return { name: 'reader', signals: ['url:chapter'], confidence: 0.95 };
 *     return { name: 'unknown', signals: [], confidence: 0 };
 *   }
 * }
 * ```
 */
export abstract class BaseSiteAdapter {
  protected classifier = new PageTypeClassifier();

  /** URL patterns specific to this site */
  abstract urlPatterns: UrlPatterns;

  /**
   * Detect the site-specific page type from URL and DOM elements.
   * Override to add custom detection logic.
   */
  abstract detectSiteType(url: string, elements: RawElement[], statusCode?: number): SitePageType;

  /**
   * Full analysis combining generic PageTypeClassifier with site-specific detection.
   */
  analyze(elements: RawElement[], pageUrl: string, pageTitle: string, statusCode = 200): SitePageAnalysis {
    const base = this.classifier.analyze(elements, pageUrl, pageTitle);
    const siteType = this.detectSiteType(pageUrl, elements, statusCode);

    return {
      ...base,
      siteType: siteType.name,
      identifiers: this.extractIdentifiers(pageUrl),
      isProtected: statusCode === 403 || statusCode === 503,
      paginationDetected: this.detectPagination(elements, pageUrl),
    };
  }

  /**
   * Extract site-specific identifiers (slug, id, title) from the URL.
   * Override to parse your site's URL structure.
   */
  extractIdentifiers(url: string): SiteIdentifiers {
    try {
      const path = new URL(url).pathname;
      // Generic: extract last path segment as slug
      const parts = path.split('/').filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) {
        return { slug: last.replace(/\.html?$/, ''), title: last.replace(/[-_]/g, ' ').replace(/\.html?$/, '') };
      }
      return {};
    } catch {
      return {};
    }
  }

  /**
   * Detect pagination in URL or DOM (page=N, _N.html, /page/N/).
   */
  detectPagination(elements: RawElement[], url: string): boolean {
    if (/_\d+\.html$/i.test(url)) return true;
    if (/[?&]page=\d+/i.test(url)) return true;
    if (/\/page\/\d+/i.test(url)) return true;

    const hasPagination = elements.some(e =>
      /pagin|page|naveg|pagina/i.test(e.class + e.text)
    );
    return hasPagination;
  }

  /**
   * Detect if a page has multiple server/hoster options.
   */
  detectServers(elements: RawElement[]): boolean {
    const clickables = elements.filter(e => e.type === 'clickable' || e.type === 'link');
    const serverTexts = clickables.filter(e =>
      /server|servidor|opcion|mirror|source|cdn|host|calidad|quality|video|player/i.test(e.text + e.class)
    );
    return serverTexts.length >= 2;
  }

  /**
   * Extract Schema.org structured data from the page (itemscope/itemprop).
   */
  async extractSchemaOrg(page: Page): Promise<Record<string, string>> {
    return await page.evaluate(() => {
      const result: Record<string, string> = {};
      document.querySelectorAll('[itemscope]').forEach(el => {
        const type = el.getAttribute('itemtype') || '';
        if (type) result['@type'] = type;
        el.querySelectorAll('[itemprop]').forEach(prop => {
          const name = prop.getAttribute('itemprop') || '';
          const value = (prop as HTMLElement).textContent?.trim()
            || prop.getAttribute('content')
            || prop.getAttribute('href')
            || '';
          if (name && value) result[name] = value;
        });
      });
      return result;
    });
  }
}
