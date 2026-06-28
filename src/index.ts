export { ScraperEngine } from './ScraperEngine';
export { loadConfig } from './config';
export { extractServers } from './extractors/ServerListExtractor';
export { cheerioStrategy, iframeStrategy, puppeteerStrategy } from './strategies';
export { BrowserPool } from './browser/BrowserPool';
export { PageInteractions } from './interactions/PageInteractions';
export { HeuristicAnalyzer } from './analysis/HeuristicAnalyzer';
export { AutonomousScraper } from './analysis/AutonomousScraper';
export { SmartAnalyzer, getSmartAnalyzer, resetSmartAnalyzer } from './analysis/SmartAnalyzer';
export { DebugViewer } from './analysis/DebugViewer';
export { SessionMemory, getSessionMemory, resetSessionMemory, textSimilarity } from './analysis/SessionMemory';
export { DynamicPageHandler } from './analysis/DynamicPageHandler';
export { StaticScraper } from './analysis/StaticScraper';
export { SkeletonDetector } from './analysis/SkeletonDetector';
export { ProxyRotator } from './proxy/ProxyRotator';
export { EmbedResolver } from './analysis/EmbedResolver';
export { CircuitBreaker, CircuitOpenError } from './analysis/CircuitBreaker';
export { MemoryWatchdog } from './analysis/MemoryWatchdog';
export { StreamNormalizer } from './analysis/StreamNormalizer';
export { ProviderRegistry, getProviderRegistry } from './analysis/ProviderRegistry';
export { ProviderMemory, getProviderMemory, resetProviderMemory } from './analysis/ProviderMemory';
export { HealthMonitor, getHealthMonitor } from './analysis/HealthMonitor';
export { LazyImageResolver } from './analysis/LazyImageResolver';
export { RedirectChainFollower, AFFILIATE_REDIRECT_DOMAINS } from './analysis/RedirectChainFollower';
export { PaginatedCategoryScraper } from './analysis/PaginatedCategoryScraper';
export { Router } from './engines/Router';
export { StreamPipeline } from './engines/StreamPipeline';
export { CrossSourceMatcher } from './engines/CrossSourceMatcher';
export { retry } from './utils/retry';
export { createLogger } from './utils/logger';
export { takeScreenshot } from './utils/screenshot';
export { solveAnubisPoW, solveAnubisPoWSync, parseSetCookie } from './utils/anubis';
export {
  ScraperError,
  ScraperTimeoutError,
  ProviderNotFoundError,
  EmbedResolveError,
} from './utils/errors';
export type {
  ScraperConfig,
  ScrapeTarget,
  ScrapeResult,
  ServerEntry,
  StrategyName,
  EngineName,
  LogLevel,
  ExtractionContext,
  StrategyResult,
  BrowserInstance,
  EmbedResult,
  StreamInfo,
  StreamQuality,
  StreamLanguage,
  CircuitState,
  ProviderConfig,
  ProviderResult,
  EngineStats,
  ProviderStats,
  HealthReport,
} from './types';
export type {
  ClickWithNavigationResult,
  SmartClickOptions,
  InteractionResult,
  LocatorLike,
} from './interactions/PageInteractions';
export type {
  HeuristicFinding,
  DomAnalysis,
} from './analysis/HeuristicAnalyzer';
export type {
  SmartScrapeResult,
  ServerCatalog,
  AutonomousScraperOptions,
  ContentGoal,
} from './analysis/AutonomousScraper';
export type {
  ElementIntent,
  ContentScore,
  URLClassification,
  URLType,
  PageZone,
  AnalysisReport,
} from './analysis/SmartAnalyzer';
export type {
  PaginationPattern,
  PaginationDetection,
  PageFetchResult,
  PaginatedScrapeResult,
  PaginatedScrapeOptions,
} from './analysis/PaginatedCategoryScraper';
export type {
  RedirectHop,
  RedirectChainResult,
  FollowRedirectOptions,
} from './analysis/RedirectChainFollower';
export type {
  LazyImageCandidate,
  LazyResolveOptions,
} from './analysis/LazyImageResolver';
export type {
  HealthSummary,
  BayesianScore,
} from './analysis/HealthMonitor';
export type {
  SourceMatch,
  CrossSourceResult,
  SearchProvider,
  CrossSourceOptions,
} from './engines/CrossSourceMatcher';
