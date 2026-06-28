import { getLogger } from '../utils/logger';

export interface RetryOptions {
  maxRetries: number;
  delayMs: number;
  onRetry?: (attempt: number, error: Error) => void;
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const log = getLogger();
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn({ attempt, maxRetries: options.maxRetries, error: lastError.message }, 'Retry attempt failed');

      if (attempt < options.maxRetries) {
        const delay = options.delayMs * Math.pow(2, attempt);
        options.onRetry?.(attempt + 1, lastError);
        await sleep(delay);
      }
    }
  }

  throw lastError!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
