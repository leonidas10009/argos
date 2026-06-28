import type { Page, ElementHandle, ClickOptions, WaitForOptions } from 'puppeteer';
import { getLogger } from '../utils/logger';

export interface LocatorLike {
  click: () => Promise<void>;
  fill: (value: string) => Promise<void>;
  hover: () => Promise<void>;
  scroll: (options?: { scrollLeft?: number; scrollTop?: number }) => Promise<void>;
  wait: () => Promise<void>;
  waitHandle: () => Promise<ElementHandle>;
}

export interface ClickWithNavigationResult {
  response: unknown;
  clicked: boolean;
}

export interface SmartClickOptions {
  selectors: string[];
  timeout?: number;
  clickOptions?: ClickOptions;
}

export interface InteractionResult {
  success: boolean;
  selector: string;
  action: string;
  error?: string;
}

export class PageInteractions {
  private page: Page;
  private defaultTimeout: number;

  constructor(page: Page, defaultTimeout = 30_000) {
    this.page = page;
    this.defaultTimeout = defaultTimeout;
  }

  get currentPage(): Page {
    return this.page;
  }

  setPage(page: Page): void {
    this.page = page;
  }

  setTimeout(ms: number): void {
    this.defaultTimeout = ms;
  }

  // ============================================================
  // CLICK: Modern Locator-style (recommended by Puppeteer docs)
  // ============================================================

  async click(selector: string, options?: ClickOptions): Promise<void> {
    const log = getLogger();
    log.debug({ selector }, 'Clicking element');
    try {
      await this.page.locator(selector).click(options);
      log.debug({ selector }, 'Click successful');
    } catch (err) {
      log.error({ selector, error: (err as Error).message }, 'Click failed');
      throw err;
    }
  }

  async clickAll(selector: string, options?: ClickOptions): Promise<void> {
    const log = getLogger();
    log.debug({ selector }, 'Clicking all matching elements');
    const handles = await this.page.$$(selector);
    for (const handle of handles) {
      try {
        await handle.click(options);
      } catch {
        log.debug('Skipping unclickable element');
      }
    }
  }

  async clickFirstAvailable(selectors: string[], options?: ClickOptions): Promise<InteractionResult> {
    const log = getLogger();
    for (const selector of selectors) {
      try {
        await this.page.waitForSelector(selector, { timeout: 3000 });
        await this.page.click(selector, options);
        log.info({ selector }, 'Clicked first available');
        return { success: true, selector, action: 'click' };
      } catch {
        log.debug({ selector }, 'Selector not available, trying next');
      }
    }
    log.warn({ selectors }, 'No selector was clickable');
    return { success: false, selector: '', action: 'click', error: 'No selector was clickable' };
  }

  // ============================================================
  // CLICK + NAVIGATION: Race-condition-safe pattern
  // ============================================================

  async clickAndWaitForNavigation(
    selector: string,
    clickOptions?: ClickOptions,
    waitOptions?: WaitForOptions,
  ): Promise<ClickWithNavigationResult> {
    const log = getLogger();
    log.debug({ selector }, 'Click + wait for navigation');
    try {
      const [response] = await Promise.all([
        this.page.waitForNavigation(waitOptions),
        this.page.click(selector, clickOptions),
      ]);
      return { response, clicked: true };
    } catch (err) {
      log.warn({ selector, error: (err as Error).message }, 'Click + navigation failed');
      return { response: null, clicked: false };
    }
  }

  async clickAndWaitForSelector(
    clickSelector: string,
    waitSelector: string,
    clickOptions?: ClickOptions,
    timeout?: number,
  ): Promise<void> {
    const log = getLogger();
    log.debug({ clickSelector, waitSelector }, 'Click + wait for selector');
    await this.page.click(clickSelector, clickOptions);
    await this.page.waitForSelector(waitSelector, { timeout: timeout || this.defaultTimeout });
    log.debug({ waitSelector }, 'Selector appeared after click');
  }

  // ============================================================
  // HOVER
  // ============================================================

  async hover(selector: string): Promise<void> {
    const log = getLogger();
    log.debug({ selector }, 'Hovering element');
    await this.page.locator(selector).hover();
  }

  // ============================================================
  // FILL / TYPE
  // ============================================================

  async fill(selector: string, value: string): Promise<void> {
    const log = getLogger();
    log.debug({ selector, value }, 'Filling input');
    await this.page.locator(selector).fill(value);
  }

  async type(selector: string, text: string, options?: { delay?: number }): Promise<void> {
    const log = getLogger();
    log.debug({ selector, text }, 'Typing text');
    await this.page.type(selector, text, options);
  }

  // ============================================================
  // SELECT (dropdowns)
  // ============================================================

  async select(selector: string, ...values: string[]): Promise<string[]> {
    const log = getLogger();
    log.debug({ selector, values }, 'Selecting option');
    return this.page.select(selector, ...values);
  }

  // ============================================================
  // FOCUS
  // ============================================================

  async focus(selector: string): Promise<void> {
    await this.page.focus(selector);
  }

  // ============================================================
  // TAP (touch)
  // ============================================================

  async tap(selector: string): Promise<void> {
    await this.page.tap(selector);
  }

  // ============================================================
  // SCROLL
  // ============================================================

  async scroll(selector: string, scrollLeft?: number, scrollTop?: number): Promise<void> {
    const log = getLogger();
    log.debug({ selector, scrollLeft, scrollTop }, 'Scrolling element');
    await this.page.locator(selector).scroll({ scrollLeft, scrollTop });
  }

  async scrollIntoView(selector: string): Promise<void> {
    const handle = await this.page.$(selector);
    if (!handle) throw new Error(`Element not found: ${selector}`);
    await handle.evaluate((el) => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
  }

  // ============================================================
  // WAIT patterns
  // ============================================================

  async waitForVisible(selector: string, timeout?: number): Promise<void> {
    await this.page.locator(selector).setTimeout(timeout || this.defaultTimeout).wait();
  }

  async waitForHidden(selector: string, timeout?: number): Promise<void> {
    await this.page.waitForSelector(selector, {
      hidden: true,
      timeout: timeout || this.defaultTimeout,
    });
  }

  async waitForFunction(fn: () => unknown, timeout?: number): Promise<void> {
    await this.page.waitForFunction(fn, { timeout: timeout || this.defaultTimeout });
  }

  // ============================================================
  // EXTRACT with interaction (click then extract)
  // ============================================================

  async clickAndExtract(
    clickSelector: string,
    extractSelector: string,
    extractFn?: (el: Element) => unknown,
    waitAfterClickMs?: number,
  ): Promise<unknown> {
    const log = getLogger();
    log.debug({ clickSelector, extractSelector }, 'Click + extract');

    try {
      await this.page.waitForSelector(clickSelector, { timeout: this.defaultTimeout });
      await this.page.click(clickSelector);

      if (waitAfterClickMs) {
        await new Promise((r) => setTimeout(r, waitAfterClickMs));
      }

      await this.page.waitForSelector(extractSelector, { timeout: this.defaultTimeout });

      if (extractFn) {
        return this.page.$eval(extractSelector, extractFn);
      }

      return this.page.$$eval(extractSelector, (elements) =>
        elements.map((el) => ({
          text: (el as HTMLElement).textContent?.trim(),
          html: (el as HTMLElement).innerHTML,
        })),
      );
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Click + extract failed');
      return null;
    }
  }

  // ============================================================
  // PAGINATION / MULTI-PAGE CLICKING
  // ============================================================

  async clickThroughPages(
    nextPageSelector: string,
    extractFn: (page: Page) => Promise<unknown[]>,
    maxPages = 10,
  ): Promise<unknown[]> {
    const log = getLogger();
    const allResults: unknown[] = [];
    let currentPage = 0;

    while (currentPage < maxPages) {
      const results = await extractFn(this.page);
      allResults.push(...results);

      const hasNext = await this.page.$(nextPageSelector);
      if (!hasNext) {
        log.debug('No next page button found');
        break;
      }

      const isDisabled = await this.page.$eval(nextPageSelector, (el) =>
        (el as HTMLElement).hasAttribute('disabled'),
      );
      if (isDisabled) break;

      try {
        await Promise.all([
          this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
          this.page.click(nextPageSelector),
        ]);
        currentPage++;
      } catch {
        log.warn('Pagination navigation failed');
        break;
      }
    }

    log.info({ pages: currentPage + 1, total: allResults.length }, 'Pagination complete');
    return allResults;
  }

  // ============================================================
  // ELEMENT EXISTS / VISIBLE checks
  // ============================================================

  async isVisible(selector: string, timeout = 3000): Promise<boolean> {
    try {
      await this.page.waitForSelector(selector, { visible: true, timeout });
      return true;
    } catch {
      return false;
    }
  }

  async exists(selector: string, timeout = 2000): Promise<boolean> {
    try {
      await this.page.waitForSelector(selector, { timeout });
      return true;
    } catch {
      return false;
    }
  }

  async count(selector: string): Promise<number> {
    return this.page.$$eval(selector, (elements) => elements.length);
  }

  // ============================================================
  // LOW-LEVEL ElementHandle access
  // ============================================================

  async getHandle(selector: string): Promise<ElementHandle<Element> | null> {
    return this.page.$(selector);
  }

  async getHandles(selector: string): Promise<ElementHandle<Element>[]> {
    return this.page.$$(selector);
  }

  // ============================================================
  // DIALOG HANDLING (alert, confirm, prompt)
  // ============================================================

  setupDialogHandler(accept = true, promptText?: string): void {
    this.page.on('dialog', async (dialog) => {
      const log = getLogger();
      log.info({ type: dialog.type(), message: dialog.message() }, 'Dialog detected');
      if (promptText !== undefined) {
        await dialog.accept(promptText);
      } else if (accept) {
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    });
  }
}
