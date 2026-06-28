import type { Browser, Page, PuppeteerLaunchOptions } from 'puppeteer';
import { existsSync } from 'node:fs';
import { getLogger } from '../utils/logger';
import type { ScraperConfig } from '../types';

let puppeteer: any;

async function getPuppeteer() {
  if (puppeteer) return puppeteer;
  // Prioridad: puppeteer-core (ligero, para usar con @sparticuz/chromium)
  // Fallback: puppeteer (incluye Chromium bundled)
  try {
    puppeteer = require('puppeteer-core');
  } catch {
    puppeteer = require('puppeteer');
  }
  return puppeteer;
}

const KNOWN_CHROME_PATHS: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    String(process.env['LOCALAPPDATA'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
  ],
};

function findSystemChrome(): string | null {
  const envPath = process.env['CHROME_PATH'] || process.env['PUPPETEER_EXECUTABLE_PATH'];
  if (envPath && existsSync(envPath)) return envPath;

  const platform = process.platform;
  const paths = KNOWN_CHROME_PATHS[platform] || [];
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }

  return null;
}

async function findSparticuzChromium(): Promise<{ path: string; args: string[] } | null> {
  try {
    // @sparticuz/chromium v133+: Chromium.executablePath() + Chromium.args
    const { default: Chromium } = require('@sparticuz/chromium');
    if (Chromium && typeof Chromium.executablePath === 'function') {
      const path = await Chromium.executablePath();
      if (path) {
        const args = Chromium.args || [];
        return { path, args };
      }
    }
  } catch { /* no instalado */ }
  return null;
}

export async function createBrowser(config: ScraperConfig): Promise<Browser> {
  const log = getLogger();
  const pup = await getPuppeteer();

  const launchArgs: string[] = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process',              // Un solo proceso → ~100MB menos
    '--disable-zygote',              // Sin zygote → menos RAM
    '--no-zygote',
    '--memory-pressure-off',         // No liberar memoria agresivamente
    '--disable-features=TranslateUI',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-breakpad',
    '--window-size=1280,720',        // Viewport mas pequeno
  ];

  if (config.stealth) {
    launchArgs.push(
      '--disable-blink-features=AutomationControlled',
    );
  }

  const launchOptions: any = {
    headless: config.headless,
    args: launchArgs,
    timeout: config.timeouts.page,
  };

  const systemChrome = findSystemChrome();
  if (systemChrome) {
    launchOptions.executablePath = systemChrome;
    log.info({ chromePath: systemChrome }, 'Browser: system Chrome');
  } else {
    const sparticuz = await findSparticuzChromium();
    if (sparticuz) {
      launchOptions.executablePath = sparticuz.path;
      if (sparticuz.args.length > 0) {
        launchOptions.args = [...sparticuz.args, ...launchArgs];
      }
      log.info({ path: sparticuz.path }, 'Browser: @sparticuz/chromium');
    } else {
      log.info('Browser: bundled Chromium (puppeteer)');
    }
  }

  if (config.proxy.enabled && config.proxy.list.length > 0) {
    const proxy = config.proxy.list[0];
    launchOptions.args!.push(`--proxy-server=${proxy}`);
    log.info({ proxy }, 'Proxy configured');
  }

  const browser = await pup.launch(launchOptions);
  log.info('Browser launched');
  return browser;
}

export async function createPage(
  browser: Browser,
  config: Pick<ScraperConfig, 'blockResources' | 'stealth' | 'timeouts'>,
): Promise<Page> {
  const page = await browser.newPage();

  await page.setViewport({ width: 1280, height: 720 });
  await page.setDefaultTimeout(config.timeouts?.page ?? 30_000);

  if (config.stealth) {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es', 'en-US', 'en'] });
      (window as unknown as Record<string, unknown>).chrome = { runtime: {} };
    });
  }

  return page;
}
