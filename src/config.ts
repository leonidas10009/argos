import 'dotenv/config';
import type { ScraperConfig, StrategyName, LogLevel } from './types';

function envList(key: string): string[] {
  const val = process.env[key];
  if (!val) return [];
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val === 'true' || val === '1';
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

function envLogLevel(key: string): LogLevel {
  const val = process.env[key] as LogLevel | undefined;
  if (val && ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(val)) {
    return val;
  }
  return 'info';
}

const DEFAULT_CONFIG: ScraperConfig = {
  strategies: ['cheerio', 'puppeteer'],
  headless: true,
  stealth: true,
  blockResources: true,

  browserPool: {
    min: 1,
    max: 3,
    idleTimeoutMs: 60_000,
  },

  proxy: {
    list: [],
    enabled: false,
  },

  retry: {
    maxRetries: 3,
    delayMs: 1000,
  },

  timeouts: {
    page: 30_000,
    global: 120_000,
  },

  screenshots: {
    enabled: true,
    dir: './screenshots',
  },

  concurrency: {
    max: 3,
  },

  logLevel: 'info',

  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 300_000,
    halfOpenMax: 2,
  },

  memoryWatchdog: {
    enabled: true,
    warningPercent: 70,
    criticalPercent: 90,
    checkIntervalMs: 30_000,
  },

  streamDeadlineMs: 45_000,
};

export function loadConfig(overrides?: Partial<ScraperConfig>): ScraperConfig {
  const proxyList = envList('PROXY_LIST');
  const strategies = envList('STRATEGIES').length > 0
    ? (envList('STRATEGIES') as StrategyName[])
    : DEFAULT_CONFIG.strategies;

  const envConfig: Partial<ScraperConfig> = {
    strategies,
    headless: envBool('HEADLESS', DEFAULT_CONFIG.headless),
    stealth: envBool('STEALTH', DEFAULT_CONFIG.stealth),
    blockResources: envBool('BLOCK_RESOURCES', DEFAULT_CONFIG.blockResources),

    browserPool: {
      min: envInt('BROWSER_POOL_MIN', DEFAULT_CONFIG.browserPool.min),
      max: envInt('BROWSER_POOL_MAX', DEFAULT_CONFIG.browserPool.max),
      idleTimeoutMs: envInt('BROWSER_IDLE_TIMEOUT_MS', DEFAULT_CONFIG.browserPool.idleTimeoutMs),
    },

    proxy: {
      list: proxyList,
      enabled: proxyList.length > 0,
    },

    retry: {
      maxRetries: envInt('MAX_RETRIES', DEFAULT_CONFIG.retry.maxRetries),
      delayMs: envInt('RETRY_DELAY_MS', DEFAULT_CONFIG.retry.delayMs),
    },

    timeouts: {
      page: envInt('PAGE_TIMEOUT_MS', DEFAULT_CONFIG.timeouts.page),
      global: envInt('GLOBAL_TIMEOUT_MS', DEFAULT_CONFIG.timeouts.global),
    },

    screenshots: {
      enabled: envBool('SCREENSHOT_ON_ERROR', DEFAULT_CONFIG.screenshots.enabled),
      dir: process.env['SCREENSHOT_DIR'] || DEFAULT_CONFIG.screenshots.dir,
    },

    concurrency: {
      max: envInt('MAX_CONCURRENT', DEFAULT_CONFIG.concurrency.max),
    },

    logLevel: envLogLevel('LOG_LEVEL'),

    circuitBreaker: {
      failureThreshold: envInt('CB_FAILURE_THRESHOLD', DEFAULT_CONFIG.circuitBreaker.failureThreshold),
      resetTimeoutMs: envInt('CB_RESET_TIMEOUT_MS', DEFAULT_CONFIG.circuitBreaker.resetTimeoutMs),
      halfOpenMax: envInt('CB_HALF_OPEN_MAX', DEFAULT_CONFIG.circuitBreaker.halfOpenMax),
    },

    memoryWatchdog: {
      enabled: envBool('MW_ENABLED', DEFAULT_CONFIG.memoryWatchdog.enabled),
      warningPercent: envInt('MW_WARNING_PERCENT', DEFAULT_CONFIG.memoryWatchdog.warningPercent),
      criticalPercent: envInt('MW_CRITICAL_PERCENT', DEFAULT_CONFIG.memoryWatchdog.criticalPercent),
      checkIntervalMs: envInt('MW_CHECK_INTERVAL_MS', DEFAULT_CONFIG.memoryWatchdog.checkIntervalMs),
    },

    streamDeadlineMs: envInt('STREAM_DEADLINE_MS', DEFAULT_CONFIG.streamDeadlineMs),
  };

  return deepMerge(DEFAULT_CONFIG, deepMerge(envConfig, overrides || {}));
}

function deepMerge<T>(base: T, overrides: Partial<T>): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = { ...base } as any;
  for (const key of Object.keys(overrides as object)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ov = (overrides as any)[key];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bv = (result as any)[key];
    if (ov !== undefined && typeof ov === 'object' && !Array.isArray(ov) && typeof bv === 'object' && !Array.isArray(bv)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[key] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[key] = ov;
    }
  }
  return result;
}
