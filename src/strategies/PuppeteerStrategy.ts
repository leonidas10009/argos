import type { Page, Browser } from 'puppeteer';
import type { ExtractionContext, StrategyResult, ScraperConfig } from '../types';
import { PageInteractions } from '../interactions/PageInteractions';
import { getLogger } from '../utils/logger';
import { takeScreenshot } from '../utils/screenshot';

export async function puppeteerStrategy(
  ctx: ExtractionContext,
  config: ScraperConfig,
  page: Page,
  browser: Browser,
): Promise<StrategyResult> {
  const log = getLogger();
  log.debug({ url: ctx.url }, 'Puppeteer strategy: starting');

  const interactions = new PageInteractions(page, config.timeouts.page);

  try {
    await page.goto(ctx.url, {
      waitUntil: 'domcontentloaded',
      timeout: config.timeouts.page,
    });

    const hasServerList = await interactions.isVisible('#lista-server', 10_000);
    if (hasServerList) {
      log.debug('Puppeteer: #lista-server found');
    } else {
      log.debug('Puppeteer: #lista-server not found, proceeding');
    }

    try {
      await page.waitForNetworkIdle({ timeout: 5_000 });
    } catch {
      log.debug('Puppeteer: network did not reach idle');
    }

    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));

    const data = await page.evaluate(() => {
      const results: Record<string, unknown> = {};

      const title = document.title;
      if (title) results['_title'] = title;

      const serverList = document.querySelector('#lista-server');
      if (serverList) {
        const servers: Record<string, unknown>[] = [];
        const children = serverList.children;

        for (let i = 0; i < children.length; i++) {
          const el = children[i];
          const server: Record<string, unknown> = {};

          const dataAttrs = (el as HTMLElement).querySelectorAll('[data-key], [data-server-prop]');
          dataAttrs.forEach((attrEl) => {
            const key = (attrEl as HTMLElement).getAttribute('data-key')
              || (attrEl as HTMLElement).getAttribute('data-server-prop')
              || '';
            if (key) server[key] = (attrEl as HTMLElement).textContent?.trim() || '';
          });

          if (Object.keys(server).length === 0) {
            const text = (el as HTMLElement).textContent?.trim();
            if (text) server['text'] = text;
          }

          if (Object.keys(server).length > 0) {
            servers.push(server);
          }
        }

        results['servers'] = servers;
      }

      const globalAttrs = document.querySelectorAll('[data-global], [data-site-info]');
      const globalData: Record<string, string> = {};
      globalAttrs.forEach((el) => {
        const key = (el as HTMLElement).getAttribute('data-global')
          || (el as HTMLElement).getAttribute('data-site-info')
          || '';
        if (key) globalData[key] = (el as HTMLElement).textContent?.trim() || '';
      });
      if (Object.keys(globalData).length > 0) {
        results['global'] = globalData;
      }

      return results;
    });

    const serverCount = (data['servers'] as unknown[])?.length || 0;
    log.info({ servers: serverCount }, 'Puppeteer strategy: success');

    return { success: true, data, strategy: 'puppeteer' };
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'Puppeteer strategy: failed');

    let screenshotPath: string | undefined;
    if (config.screenshots.enabled) {
      try {
        screenshotPath = await takeScreenshot(page, config.screenshots.dir, 'puppeteer_error');
      } catch {
        // ignore screenshot failure
      }
    }

    return {
      success: false,
      data: { error: (err as Error).message, screenshotPath },
      strategy: 'puppeteer',
    };
  }
}
