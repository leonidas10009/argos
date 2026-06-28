import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'puppeteer';
import { getLogger } from './logger';

export function ensureScreenshotDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export async function takeScreenshot(page: Page, dir: string, prefix: string): Promise<string> {
  ensureScreenshotDir(dir);
  const timestamp = Date.now();
  const filename = `${prefix}_${timestamp}.png`;
  const filepath = join(dir, filename);

  const log = getLogger();
  try {
    await page.screenshot({ path: filepath, fullPage: true });
    log.info({ filepath }, 'Screenshot saved');
    return filepath;
  } catch (err) {
    log.error({ error: (err as Error).message }, 'Screenshot failed');
    return '';
  }
}
