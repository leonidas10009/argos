import type { Browser, Page } from 'puppeteer';

export type StrategyName = 'cheerio' | 'iframe' | 'puppeteer';
export type EngineName = 'static' | 'dynamic' | 'intelligent';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface ScraperConfig {
  strategies: StrategyName[];
  headless: boolean;
  stealth: boolean;
  blockResources: boolean;

  browserPool: {
    min: number;
    max: number;
    idleTimeoutMs: number;
  };

  proxy: {
    list: string[];
    enabled: boolean;
  };

  retry: {
    maxRetries: number;
    delayMs: number;
  };

  timeouts: {
    page: number;
    global: number;
  };

  screenshots: {
    enabled: boolean;
    dir: string;
  };

  concurrency: {
    max: number;
  };

  logLevel: LogLevel;

  circuitBreaker: {
    failureThreshold: number;
    resetTimeoutMs: number;
    halfOpenMax: number;
  };

  memoryWatchdog: {
    enabled: boolean;
    warningPercent: number;
    criticalPercent: number;
    checkIntervalMs: number;
  };

  streamDeadlineMs: number;
}

export interface ScrapeTarget {
  url: string;
  selectors?: string[];
  waitForSelector?: string;
  waitForTimeout?: number;
}

export interface ScrapeResult {
  url: string;
  strategy: StrategyName;
  success: boolean;
  data: unknown;
  durationMs: number;
  error?: string;
  screenshotPath?: string;
  retries: number;
}

export interface ServerEntry {
  name: string;
  url: string;
  status?: string;
  players?: string;
  version?: string;
  [key: string]: unknown;
}

export interface ExtractionContext {
  url: string;
  html?: string;
  page?: Page;
  browser?: Browser;
}

export interface StrategyResult {
  success: boolean;
  data: unknown;
  strategy: StrategyName;
}

export interface BrowserInstance {
  id: string;
  browser: Browser;
  inUse: boolean;
  createdAt: number;
  lastUsedAt: number;
  usageCount: number;
}

export interface EmbedResult {
  embedUrl: string;
  directUrl: string | null;
  serverName: string;
  domain: string;
  method: string;
  durationMs: number;
  error?: string;
}

export type StreamQuality = '4K' | '1080p' | '720p' | '480p' | '360p' | 'CAM' | 'HD' | 'SD' | 'unknown';
export type StreamLanguage = 'ES' | 'EN' | 'JA' | 'KO' | 'PT' | 'FR' | 'ZH' | 'TR' | 'unknown';

export interface StreamInfo {
  url: string;
  directUrl: string | null;
  serverName: string;
  quality: StreamQuality;
  language: StreamLanguage;
  type: 'm3u8' | 'mp4' | 'mkv' | 'webm' | 'embed' | 'torrent' | 'other';
  labels: string[];
  priority: number;
}

export interface CircuitState {
  provider: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  lastFailure: number;
  lastSuccess: number;
  openedAt: number | null;
}

export interface ProviderConfig {
  name: string;
  title: string;
  baseUrl: string;
  language: string;
  categories: string[];
  active: boolean;
  search: {
    url: string;
    method?: 'GET' | 'POST';
    itemSelector: string;
    titleSelector: string;
    linkSelector: string;
    nextPageSelector?: string;
  };
  episodes?: {
    type: 'url' | 'post' | 'season-list' | 'jsvar' | 'nextjs' | 'none';
    pattern?: string;
    seasonParam?: string;
    episodeParam?: string;
    containerSelector?: string;
    itemSelector?: string;
    linkSelector?: string;
  };
  videos: {
    type: 'iframe' | 'iframe-chain' | 'nextjs' | 'jsvar' | 'jslist' | 'onclick' | 'data-attr' | 'jkplayer' | 'api' | 'none';
    containerSelector?: string;
    iframeSelector?: string;
    srcAttr?: string;
    dataKey?: string;
  };
}

export interface ProviderResult {
  provider: string;
  engine: EngineName;
  phase: 'search' | 'videos';
  success: boolean;
  durationMs: number;
  results: unknown[];
  error?: string;
}

export interface EngineStats {
  engine: EngineName;
  successRate: number;
  confidence: number;
  successes: number;
  failures: number;
  avgDuration: number;
  phases: Record<string, { successes: number; failures: number }>;
}

export interface ProviderStats {
  name: string;
  totalAttempts: number;
  successRate: number;
  lastDuration: number;
  recommendedOrder: EngineName[];
  engines: Record<string, EngineStats>;
}

export interface HealthReport {
  provider: string;
  status: 'healthy' | 'degraded' | 'failed';
  uptime: number;
  attempts: number;
  successRate: number;
  circuitState: CircuitState['state'];
  lastCheck: number;
}
