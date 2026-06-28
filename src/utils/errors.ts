export class ScraperError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ScraperError';
    this.code = code;
    this.details = details;
  }
}

export class ScraperTimeoutError extends ScraperError {
  constructor(operation: string, timeoutMs: number, provider?: string) {
    super(
      `${operation} timed out after ${timeoutMs}ms`,
      'TIMEOUT',
      { operation, timeoutMs, provider },
    );
    this.name = 'ScraperTimeoutError';
  }
}

export class ProviderNotFoundError extends ScraperError {
  constructor(providerName: string) {
    super(
      `Provider not found: ${providerName}`,
      'PROVIDER_NOT_FOUND',
      { provider: providerName },
    );
    this.name = 'ProviderNotFoundError';
  }
}

export class EmbedResolveError extends ScraperError {
  constructor(embedUrl: string, domain: string, reason?: string) {
    super(
      `Failed to resolve embed: ${domain}`,
      'EMBED_RESOLVE_FAILED',
      { embedUrl, domain, reason },
    );
    this.name = 'EmbedResolveError';
  }
}

export { CircuitOpenError } from '../analysis/CircuitBreaker';