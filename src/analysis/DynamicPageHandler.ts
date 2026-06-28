import type { Page } from 'puppeteer';
import { getLogger } from '../utils/logger';

// ============================================================
// TIPOS
// ============================================================

export interface WaitOptions {
  timeout?: number;
  checkInterval?: number;
  waitForSelectors?: string[];
  waitForNetworkIdle?: boolean;
  networkIdleTime?: number;
  minDomStability?: number;    // ms sin cambios en el DOM
  waitForUrlChange?: boolean;  // esperar que cambie la URL (SPA)
}

export interface ScrollResult {
  totalScrolled: number;
  newElementsFound: number;
  reachedBottom: boolean;
  scrolls: number;
}

export interface DomSnapshot {
  nodeCount: number;
  iframeCount: number;
  linkCount: number;
  visibleText: number;
  timestamp: number;
}

// ============================================================
// DYNAMIC PAGE HANDLER
// ============================================================

export class DynamicPageHandler {
  private page: Page;
  private adaptiveWaitMs = 2000;

  constructor(page: Page) {
    this.page = page;
  }

  // ============================================================
  // NAVEGACION SPA-AWARE
  // ============================================================

  async navigate(
    url: string,
    options?: { timeout?: number; waitForSPA?: boolean },
  ): Promise<void> {
    const log = getLogger();
    const timeout = options?.timeout || 15000;

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      log.debug({ url, error: (err as Error).message }, 'Navigation failed');
    }
  }

  // ============================================================
  // ESPERA INTELIGENTE (SPA, lazy loading, AJAX)
  // ============================================================

  async waitForContent(options: WaitOptions = {}): Promise<void> {
    const {
      timeout = 10000,
      checkInterval = 250,
      waitForSelectors = [],
      waitForNetworkIdle = false,
      networkIdleTime = 500,
      minDomStability = 300,
      waitForUrlChange = false,
    } = options;

    const log = getLogger();
    const start = Date.now();
    let lastNodeCount = 0;
    let stableSince = 0;
    let networkIdleSince = 0;
    let requestCount = 0;

    // Contar requests pendientes
    if (waitForNetworkIdle) {
      try {
        const client = await this.page.target().createCDPSession();
        await client.send('Network.enable');
        const pendingReqs = new Set<string>();
        client.on('Network.requestWillBeSent', (params: any) => {
          pendingReqs.add(params.requestId);
          requestCount++;
        });
        client.on('Network.loadingFinished', (params: any) => {
          pendingReqs.delete(params.requestId);
        });
        client.on('Network.loadingFailed', (params: any) => {
          pendingReqs.delete(params.requestId);
        });

        // Monitorear en bucle
        while (Date.now() - start < timeout) {
          await new Promise(r => setTimeout(r, checkInterval));

          const nodeCount = await this.getDomCount();
          const urlChanged = waitForUrlChange
            ? await this.page.evaluate(() => (window as any).__scraper_initial_url !== window.location.href).catch(() => false)
            : false;

          // Estabilidad del DOM
          if (nodeCount === lastNodeCount) {
            stableSince += checkInterval;
          } else {
            stableSince = 0;
            lastNodeCount = nodeCount;
            this.adaptiveWaitMs = Math.min(this.adaptiveWaitMs + 200, 5000);
          }

          // Network idle
          if (pendingReqs.size === 0) {
            networkIdleSince += checkInterval;
          } else {
            networkIdleSince = 0;
          }

          // Selectores
          let selectorsReady = true;
          for (const sel of waitForSelectors) {
            const exists = await this.page.$(sel).then(el => !!el).catch(() => false);
            if (!exists) { selectorsReady = false; break; }
          }

          // Condicion de salida
          const domStable = stableSince >= minDomStability;
          const netIdle = !waitForNetworkIdle || networkIdleSince >= networkIdleTime;
          const selOk = waitForSelectors.length === 0 || selectorsReady;
          const urlOk = !waitForUrlChange || urlChanged;

          if (domStable && netIdle && selOk && urlOk) {
            log.debug({
              elapsed: Date.now() - start,
              stableMs: stableSince,
              requests: requestCount,
              nodes: nodeCount,
            }, 'Content ready (smart wait)');
            await client.send('Network.disable').catch(() => {});
            return;
          }
        }
        await client.send('Network.disable').catch(() => {});
      } catch {
        // CDP fallback: espera simple
        log.debug('CDP wait failed, using basic wait');
      }
    }

    // Fallback: espera por selectores o timeout fijo
    const remaining = timeout - (Date.now() - start);
    if (waitForSelectors.length > 0 && remaining > 0) {
      for (const sel of waitForSelectors) {
        try {
          await this.page.waitForSelector(sel, { timeout: remaining });
        } catch { /* seguir */ }
      }
    }

    // Espera adaptativa minima
    const elapsed = Date.now() - start;
    if (elapsed < this.adaptiveWaitMs) {
      await new Promise(r => setTimeout(r, this.adaptiveWaitMs - elapsed));
    }
  }

  // ============================================================
  // INFINITE SCROLL / LAZY LOADING
  // ============================================================

  async scrollToLoadAll(options?: {
    maxScrolls?: number;
    scrollDelay?: number;
    scrollStep?: number;
    maxNewElements?: number;
  }): Promise<ScrollResult> {
    const {
      maxScrolls = 15,
      scrollDelay = 1500,
      scrollStep = 800,
      maxNewElements = 0,
    } = options || {};

    const log = getLogger();
    let totalScrolled = 0;
    let totalNewElements = 0;
    let scrolls = 0;
    let reachedBottom = false;
    let noChangeCount = 0;

    const initialCount = await this.getDomCount();

    for (let i = 0; i < maxScrolls; i++) {
      scrolls++;

      // Scroll step
      await this.page.evaluate((step) => {
        window.scrollBy(0, step);
      }, scrollStep);
      totalScrolled += scrollStep;

      // Esperar carga de contenido lazy
      await new Promise(r => setTimeout(r, scrollDelay));

      // Disparar lazy images/iframes
      await this.triggerLazyElements();

      // Esperar estabilidad
      await new Promise(r => setTimeout(r, 500));

      const currentCount = await this.getDomCount();
      const newElements = currentCount - initialCount - totalNewElements;
      totalNewElements += Math.max(0, newElements);

      // Ver si llegamos al fondo
      reachedBottom = await this.page.evaluate(() => {
        return window.innerHeight + window.scrollY >= document.body.scrollHeight - 50;
      });

      if (newElements <= 2) {
        noChangeCount++;
      } else {
        noChangeCount = 0;
      }

      // Parar si: llegamos al fondo o 3 scrolls sin cambios
      if (reachedBottom && noChangeCount >= 1) break;
      if (noChangeCount >= 3) break;
      if (maxNewElements > 0 && totalNewElements >= maxNewElements) break;
    }

    log.info({
      scrolls,
      newElements: totalNewElements,
      reachedBottom,
      scrolled: totalScrolled,
    }, 'Infinite scroll complete');

    return { totalScrolled, newElementsFound: totalNewElements, reachedBottom, scrolls };
  }

  // ============================================================
  // TRIGGER LAZY CONTENT
  // ============================================================

  async triggerLazyElements(): Promise<number> {
    const result = await this.page.evaluate(() => {
      let triggered = 0;

      // Imagenes lazy
      const lazyImgs = document.querySelectorAll('img[loading="lazy"], img[data-src], img[data-lazy], img[data-original]');
      lazyImgs.forEach((img) => {
        const el = img as HTMLImageElement;
        const src = el.getAttribute('data-src') || el.getAttribute('data-lazy') || el.getAttribute('data-original');
        if (src && !el.src) {
          el.src = src;
          triggered++;
        }
        if (el.loading === 'lazy') {
          el.loading = 'eager';
          triggered++;
        }
      });

      // Iframes lazy
      const lazyIframes = document.querySelectorAll('iframe[loading="lazy"], iframe[data-src]');
      lazyIframes.forEach((f) => {
        const el = f as HTMLIFrameElement;
        const src = el.getAttribute('data-src');
        if (src && !el.src) {
          el.src = src;
          triggered++;
        }
      });

      // Elementos con Intersection Observer virtual
      const hiddenDivs = document.querySelectorAll('[data-loaded="false"], .lazy-hidden, .lazyload');
      hiddenDivs.forEach((el) => {
        (el as HTMLElement).style.display = (el as HTMLElement).style.display || 'block';
        (el as HTMLElement).classList.remove('lazy-hidden', 'lazyload');
        triggered++;
      });

      return triggered;
    });

    if (result > 0) {
      getLogger().debug({ triggered: result }, 'Lazy elements triggered');
    }

    return result as number;
  }

  // ============================================================
  // SHADOW DOM PIERCING
  // ============================================================

  async getDomCount(): Promise<number> {
    return this.page.evaluate(() => {
      function countInRoot(root: Document | ShadowRoot | Element): number {
        let count = root.querySelectorAll('*').length;
        const shadowHosts = root.querySelectorAll('*');
        shadowHosts.forEach((el) => {
          if ((el as any).shadowRoot) {
            count += countInRoot((el as any).shadowRoot);
          }
        });
        return count;
      }
      return countInRoot(document);
    }) as Promise<number>;
  }

  async extractAllElements(): Promise<string> {
    return this.page.evaluate(() => {
      function extractFromRoot(root: Document | ShadowRoot | Element): string[] {
        const elements = root.querySelectorAll('*');
        const html: string[] = [];
        for (let i = 0; i < elements.length; i++) {
          const el = elements[i] as HTMLElement;
          let tag = el.tagName.toLowerCase();
          if (el.id) tag += '#' + el.id;
          if (el.className && typeof el.className === 'string') {
            const cls = el.className.toString().trim().split(/\s+/)[0];
            if (cls && cls.length > 1) tag += '.' + cls;
          }
          html.push(tag);
          // Piercing
          if ((el as any).shadowRoot) {
            html.push(...extractFromRoot((el as any).shadowRoot));
          }
        }
        return html;
      }
      return extractFromRoot(document).join('|');
    }) as Promise<string>;
  }

  // ============================================================
  // SPA NAVIGATION DETECTION
  // ============================================================

  async waitForSPANavigation(timeout = 10000): Promise<boolean> {
    const log = getLogger();
    const start = Date.now();

    try {
      // Interceptar cambios de URL via History API
      await this.page.evaluate(() => {
        if (!(window as any).__scraper_spa_hooked) {
          (window as any).__scraper_spa_hooked = true;
          (window as any).__scraper_spa_navigated = false;
          const origPush = history.pushState;
          const origReplace = history.replaceState;
          history.pushState = function (...args: any[]) {
            (window as any).__scraper_spa_navigated = true;
            return (origPush as any).apply(history, args);
          };
          history.replaceState = function (...args: any[]) {
            (window as any).__scraper_spa_navigated = true;
            return (origReplace as any).apply(history, args);
          };
          window.addEventListener('popstate', () => {
            (window as any).__scraper_spa_navigated = true;
          });
        }
      }).catch(() => {});

      // Esperar navegacion
      while (Date.now() - start < timeout) {
        const navigated = await this.page.evaluate(
          () => (window as any).__scraper_spa_navigated || false
        ).catch(() => false);

        if (navigated) {
          await this.page.evaluate(() => { (window as any).__scraper_spa_navigated = false; }).catch(() => {});
          log.debug('SPA navigation detected');
          return true;
        }
        await new Promise(r => setTimeout(r, 300));
      }
    } catch { /* ignore */ }

    return false;
  }

  // ============================================================
  // COMPARAR DOM (detectar cambios post-interaccion)
  // ============================================================

  async takeDomSnapshot(): Promise<DomSnapshot> {
    return this.page.evaluate(() => {
      return {
        nodeCount: document.querySelectorAll('*').length,
        iframeCount: document.querySelectorAll('iframe').length,
        linkCount: document.querySelectorAll('a[href]').length,
        visibleText: (document.body?.textContent || '').length,
        timestamp: Date.now(),
      };
    }) as Promise<DomSnapshot>;
  }

  compareDomSnapshots(before: DomSnapshot, after: DomSnapshot): { changed: boolean; details: string } {
    const diffs: string[] = [];
    if (after.nodeCount !== before.nodeCount) {
      diffs.push(`nodes: ${before.nodeCount} → ${after.nodeCount} (${after.nodeCount > before.nodeCount ? '+' : ''}${after.nodeCount - before.nodeCount})`);
    }
    if (after.iframeCount !== before.iframeCount) {
      diffs.push(`iframes: ${before.iframeCount} → ${after.iframeCount}`);
    }
    if (after.linkCount !== before.linkCount) {
      diffs.push(`links: ${before.linkCount} → ${after.linkCount}`);
    }
    const textChange = after.visibleText - before.visibleText;
    if (Math.abs(textChange) > 50) {
      diffs.push(`text: ${textChange > 0 ? '+' : ''}${textChange} chars`);
    }
    return {
      changed: diffs.length > 0,
      details: diffs.join(' | ') || 'no changes',
    };
  }

  // ============================================================
  // NETWORK INTERCEPTION (capturar URLs de peticiones AJAX/fetch)
  // ============================================================

  async interceptClick(
    clickSelector: string,
    urlPattern: RegExp = /player|embed|stream|video|m3u8|mp4|download|descarg/i,
    timeout = 8000,
  ): Promise<string[]> {
    const capturedUrls = new Set<string>();
    const log = getLogger();

    const handler = (response: any) => {
      try {
        const url = response.url();
        if (urlPattern.test(url)) capturedUrls.add(url);
      } catch { /* ignore */ }
    };

    try {
      this.page.on('response', handler);
      await this.page.waitForSelector(clickSelector, { timeout: 3000 });
      await this.page.click(clickSelector);
      await new Promise(r => setTimeout(r, timeout));
      this.page.off('response', handler);

      const urls = [...capturedUrls];
      if (urls.length > 0) {
        log.info({ selector: clickSelector.slice(0, 40), count: urls.length }, 'Network interception captured URLs');
      }
      return urls;
    } catch (err) {
      this.page.off('response', handler);
      log.debug({ error: (err as Error).message }, 'Network interception failed');
      return [];
    }
  }

  async clickAndCaptureUrls(
    clickSelector: string,
    timeout = 6000,
  ): Promise<string[]> {
    const capturedUrls = new Set<string>();

    const handler = (response: any) => {
      try {
        const url = response.url();
        if (url && url.startsWith('http') && !url.includes('google') && !url.includes('analytics')) {
          capturedUrls.add(url);
        }
      } catch { /* ignore */ }
    };

    try {
      this.page.on('response', handler);
      await this.page.waitForSelector(clickSelector, { timeout: 3000 });
      await this.page.click(clickSelector);
      await new Promise(r => setTimeout(r, timeout));
      this.page.off('response', handler);

      // Tambien revisar iframes actualizados
      const iframeUrls = await this.page.evaluate(() => {
        const iframes = document.querySelectorAll('iframe');
        const urls: string[] = [];
        iframes.forEach(f => {
          const src = (f as HTMLIFrameElement).src;
          if (src && src !== 'about:blank') urls.push(src);
        });
        return urls;
      });
      iframeUrls.forEach(u => capturedUrls.add(u));

      return [...capturedUrls];
    } catch (err) {
      this.page.off('response', handler);
      getLogger().debug({ error: (err as Error).message }, 'clickAndCapture failed');
      return [];
    }
  }

  // ============================================================
  // UTILIDADES
  // ============================================================

  getAdaptiveWaitMs(): number {
    return this.adaptiveWaitMs;
  }

  resetAdaptiveWait(): void {
    this.adaptiveWaitMs = 2000;
  }
}
