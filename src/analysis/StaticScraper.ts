import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { SmartAnalyzer } from './SmartAnalyzer';
import { SessionMemory, textSimilarity } from './SessionMemory';
import type { RawElement } from './types';
import { getLogger } from '../utils/logger';

// ============================================================
// TIPOS
// ============================================================

export interface StaticScrapeResult {
  url: string;
  title: string;
  urlsFound: number;
  serverCatalog: {
    name: string;
    domain: string;
    urls: { url: string; type: string; label: string }[];
  }[];
  findings: {
    videoUrls: string[];
    downloadUrls: string[];
    serverUrls: string[];
    navigationUrls: string[];
    otherUrls: string[];
  };
  goal: string;
  durationMs: number;
}

// ============================================================
// STATIC SCRAPER - Analisis sin navegador (fetch + cheerio)
// ============================================================

export class StaticScraper {
  private ai: SmartAnalyzer;
  private memory: SessionMemory;

  constructor() {
    this.ai = new SmartAnalyzer();
    this.memory = new SessionMemory();
  }

  async analyze(url: string): Promise<StaticScrapeResult> {
    const log = getLogger();
    const start = Date.now();
    log.info({ url }, 'Static analysis started (no browser)');

    // Fetch HTML
    const html = await this.fetchHtml(url);
    if (!html) {
      return this.emptyResult(url, start);
    }

    const $ = cheerio.load(html);

    // Construir modelo de elementos via cheerio
    const elements = this.buildStaticModel($);
    log.info({ elements: elements.length }, 'Static DOM model built');

    // Extraer todas las URLs
    const allUrls = this.extractUrlsFromStatic($, html);
    const urlCollector = allUrls.map(u => ({ url: u, category: 'unknown', source: 'static-scan' }));

    log.info({ urls: allUrls.length }, 'URLs extracted from static HTML');

    // Detectar tipo de contenido
    const goal = this.detectGoal(elements);
    log.info({ goal }, 'Content goal detected');

    // Clasificar URLs
    const findings = this.classifyUrls(urlCollector);

    // Construir catalogo de servidores
    const serverCatalog = this.buildCatalog(urlCollector);

    const duration = Date.now() - start;
    log.info({ servers: serverCatalog.length, urls: allUrls.length, duration }, 'Static analysis complete');

    return {
      url,
      title: $('title').text().trim(),
      urlsFound: allUrls.length,
      serverCatalog,
      findings,
      goal,
      durationMs: duration,
    };
  }

  // ============================================================
  // FETCH (ligero, sin navegador)
  // ============================================================

  private async fetchHtml(url: string): Promise<string | null> {
    const log = getLogger();
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        log.warn({ status: response.status, url }, 'Fetch failed');
        return null;
      }

      const html = await response.text();
      log.debug({ bytes: html.length }, 'HTML fetched');
      return html;
    } catch (err) {
      log.warn({ url, error: (err as Error).message }, 'Fetch error');
      return null;
    }
  }

  // ============================================================
  // MODELO DE DOM ESTATICO (cheerio → RawElement[])
  // ============================================================

  private buildStaticModel($: CheerioAPI): RawElement[] {
    const elements: RawElement[] = [];

    $('a, button, input, select, iframe, img, video, audio, li, h1, h2, h3, div, form, span').each((i, el) => {
      if (i > 300) return false;

      const $el = $(el);
      const tag = (el as any).tagName?.toLowerCase() || 'div';
      const text = $el.text().trim().replace(/\s+/g, ' ').slice(0, 60);

      // Skip empty containers
      if (['div', 'span'].includes(tag) && text.length === 0 && $el.children().length === 0) return;

      const attrs: Record<string, string> = {};
      const attrNames = ['id', 'class', 'href', 'src', 'onclick', 'placeholder', 'type', 'alt', 'title', 'data-url', 'data-src', 'data-anime', 'data-value'];
      for (const name of attrNames) {
        const val = $el.attr(name);
        if (val) attrs[name] = val.slice(0, 200);
      }

      let type = 'container';
      if (tag === 'a' || attrs['href']) type = 'link';
      else if (tag === 'button' || attrs['onclick']) type = 'clickable';
      else if (tag === 'input' || tag === 'textarea') type = 'input';
      else if (tag === 'select') type = 'select';
      else if (tag === 'img') type = 'image';
      else if (tag === 'iframe') type = 'iframe';
      else if (tag === 'video' || tag === 'audio') type = 'media';
      else if (/^h[1-6]$/.test(tag)) type = 'heading';
      else if (tag === 'li') type = 'list-item';

      const cls = (attrs['class'] || '').split(/\s+/)[0] || '';
      const parent = $el.parent().attr('id') || $el.parent().attr('class')?.split(/\s+/)[0] || $el.parent().get(0)?.tagName || '';

      elements.push({
        tag,
        selector: attrs['id'] ? '#' + attrs['id'] : tag + (cls ? '.' + cls : ''),
        id: attrs['id'] || '',
        class: (attrs['class'] || '').slice(0, 80),
        text,
        type,
        attr: attrs,
        children: [],
        parent: parent?.toLowerCase() || '',
        depth: 0,
      });
    });

    return elements;
  }

  // ============================================================
  // EXTRACCION DE URLs DESDE HTML ESTATICO
  // ============================================================

  private extractUrlsFromStatic($: CheerioAPI, html: string): string[] {
    const seen = new Set<string>();
    const add = (u: string) => {
      if (!u || u.startsWith('#') || u.startsWith('javascript:') || u === 'about:blank') return;
      seen.add(u);
    };

    // iframes
    $('iframe').each((_, el) => {
      add($(el).attr('src') || $(el).attr('data-src') || '');
    });

    // links
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.startsWith('http') || href.startsWith('/')) add(href);
    });

    // media
    $('video, audio, embed, object, source').each((_, el) => {
      add($(el).attr('src') || $(el).attr('data') || '');
    });

    // data-url, data-src, data-video, data-embed
    $('[data-url], [data-src], [data-video], [data-embed], [data-href], [data-link]').each((_, el) => {
      add($(el).attr('data-url') || $(el).attr('data-src') || $(el).attr('data-video') || $(el).attr('data-embed') || $(el).attr('data-href') || $(el).attr('data-link') || '');
    });

    // onclick URLs
    const onclickRegex = /https?:\/\/[^'")\s]+/g;
    const onclickMatches = html.match(onclickRegex);
    if (onclickMatches) onclickMatches.forEach(add);

    // Script URLs
    const scriptRegex = /https?:\/\/[^"'\s<>]{10,300}/g;
    const scriptMatches = html.match(scriptRegex);
    if (scriptMatches) {
      scriptMatches.filter(u => /player|embed|stream|video|download|descarg|mp4|m3u8|hls|server|cdn/i.test(u))
        .forEach(add);
    }

    return [...seen];
  }

  // ============================================================
  // UTILIDADES
  // ============================================================

  private detectGoal(elements: RawElement[]): string {
    const texts = elements.map(e => e.text + ' ' + e.class).join(' ').toLowerCase();
    if (/manga|manhwa|cap[ií]tulo|chapter/i.test(texts)) return 'manga';
    if (/anime|episodio|pelicula|serie/i.test(texts)) return 'video';
    if (/descarg|download|zip|rar/i.test(texts)) return 'download';
    if (/galer[ií]a|wallpaper|fanart/i.test(texts)) return 'image';
    const hasIframes = elements.some(e => e.type === 'iframe');
    return hasIframes ? 'video' : 'navigation';
  }

  private classifyUrls(collector: { url: string; category: string; source: string }[]): StaticScrapeResult['findings'] {
    const result = {
      videoUrls: [] as string[],
      downloadUrls: [] as string[],
      serverUrls: [] as string[],
      navigationUrls: [] as string[],
      otherUrls: [] as string[],
    };

    const seen = new Set<string>();
    for (const entry of collector) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);

      const cls = this.ai.classifyURL(entry.url, entry.source);
      switch (cls.type) {
        case 'direct-video': case 'stream': result.videoUrls.push(entry.url); break;
        case 'download': result.downloadUrls.push(entry.url); break;
        case 'embed': result.serverUrls.push(entry.url); break;
        case 'navigation': result.navigationUrls.push(entry.url); break;
        default: result.otherUrls.push(entry.url);
      }
    }

    return result;
  }

  private buildCatalog(collector: { url: string; category: string; source: string }[]): StaticScrapeResult['serverCatalog'] {
    const servers = new Map<string, { url: string; type: string; label: string }[]>();

    for (const entry of collector) {
      const domain = this.ai.extractDomain(entry.url);
      const name = this.ai.inferServerName(domain);
      const cls = this.ai.classifyURL(entry.url, entry.source);

      if (!servers.has(name)) servers.set(name, []);
      servers.get(name)!.push({
        url: entry.url,
        type: cls.type,
        label: entry.source.slice(0, 40),
      });
    }

    return [...servers.entries()]
      .map(([name, urls]) => ({ name, domain: urls[0]?.url ? this.ai.extractDomain(urls[0].url) : '', urls: urls.slice(0, 8) }))
      .sort((a, b) => b.urls.length - a.urls.length);
  }

  private emptyResult(url: string, start: number): StaticScrapeResult {
    return {
      url, title: '', urlsFound: 0, serverCatalog: [],
      findings: { videoUrls: [], downloadUrls: [], serverUrls: [], navigationUrls: [], otherUrls: [] },
      goal: 'unknown', durationMs: Date.now() - start,
    };
  }
}
