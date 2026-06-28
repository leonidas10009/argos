import * as cheerio from 'cheerio';
import type { ExtractionContext, StrategyResult } from '../types';
import { getLogger } from '../utils/logger';

export async function cheerioStrategy(ctx: ExtractionContext): Promise<StrategyResult> {
  const log = getLogger();
  log.debug({ url: ctx.url }, 'Cheerio strategy: starting');

  try {
    let html = ctx.html;

    if (!html) {
      const start = Date.now();
      const response = await fetch(ctx.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return { success: false, data: null, strategy: 'cheerio' };
      }

      html = await response.text();
      log.debug({ ms: Date.now() - start, bytes: html.length }, 'Cheerio: HTML fetched');
    }

    if (!html) {
      return { success: false, data: null, strategy: 'cheerio' };
    }

    const $ = cheerio.load(html);
    const data: Record<string, unknown> = {};

    const title = $('title').text().trim();
    if (title) data['_title'] = title;

    const serverElements = $('#lista-server > li, #lista-server > div, #lista-server > *');
    if (serverElements.length > 0) {
      const servers: Record<string, unknown>[] = [];
      serverElements.each((_, el) => {
        const $el = $(el);
        const server: Record<string, unknown> = {};

        $el.find('[data-key], [data-server-prop]').each((__, attrEl) => {
          const $attr = $(attrEl);
          const key = $attr.attr('data-key') || $attr.attr('data-server-prop') || '';
          if (key) server[key] = $attr.text().trim();
        });

        const text = $el.text().trim();
        if (text && Object.keys(server).length === 0) {
          server['text'] = text;
        }

        servers.push(server);
      });
      data['servers'] = servers;
    }

    const globalData: Record<string, string> = {};
    $('[data-global], [data-site-info]').each((_, el) => {
      const $el = $(el);
      const key = $el.attr('data-global') || $el.attr('data-site-info') || '';
      if (key) globalData[key] = $el.text().trim();
    });
    if (Object.keys(globalData).length > 0) {
      data['global'] = globalData;
    }

    log.info({ servers: (data['servers'] as unknown[])?.length || 0 }, 'Cheerio strategy: success');
    return { success: true, data, strategy: 'cheerio' };
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'Cheerio strategy: failed');
    return { success: false, data: null, strategy: 'cheerio' };
  }
}
