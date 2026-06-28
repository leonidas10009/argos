import type { Page } from 'puppeteer';
import type { ExtractionContext, StrategyResult } from '../types';
import { getLogger } from '../utils/logger';

export async function iframeStrategy(ctx: ExtractionContext): Promise<StrategyResult> {
  const log = getLogger();
  log.debug({ url: ctx.url }, 'Iframe strategy: starting');

  try {
    if (!ctx.page) {
      return { success: false, data: null, strategy: 'iframe' };
    }

    const iframeData = await ctx.page.evaluate(() => {
      const wrapper = document.querySelector('.reproductor-wrapper');
      if (!wrapper) return null;

      const iframe = wrapper.querySelector('iframe');
      if (!iframe) return null;

      const src = iframe.getAttribute('src') || '';
      const bounding = iframe.getBoundingClientRect();

      return {
        iframeSrc: src,
        width: bounding.width,
        height: bounding.height,
        visible: bounding.width > 0 && bounding.height > 0,
      };
    });

    if (!iframeData) {
      log.debug('Iframe strategy: no iframe found');
      return { success: false, data: null, strategy: 'iframe' };
    }

    log.info({ iframeSrc: iframeData.iframeSrc }, 'Iframe strategy: success');
    return {
      success: true,
      data: {
        iframe: iframeData,
        extractedAt: new Date().toISOString(),
      },
      strategy: 'iframe',
    };
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'Iframe strategy: failed');
    return { success: false, data: null, strategy: 'iframe' };
  }
}
