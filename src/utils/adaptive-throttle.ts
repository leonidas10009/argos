import { getLogger } from './logger';

export interface AdaptiveThrottleOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
  recoveryRate?: number;
  maxConsecutive429?: number;
}

/**
 * Adaptive rate limiter that adjusts delay based on server response codes.
 * - Increases delay exponentially on 429 (Too Many Requests) or 503
 * - Gradually decreases delay on successful requests
 * - Tracks consecutive failures to detect aggressive blocking
 */
export class AdaptiveThrottle {
  private currentDelay: number;
  private consecutive429 = 0;
  private consecutiveSuccess = 0;
  private totalRequests = 0;
  private total429s = 0;
  private minDelay: number;
  private maxDelay: number;
  private backoffMultiplier: number;
  private recoveryRate: number;
  private maxConsecutive429: number;

  constructor(options: AdaptiveThrottleOptions = {}) {
    this.minDelay = options.minDelayMs ?? 200;
    this.maxDelay = options.maxDelayMs ?? 30_000;
    this.currentDelay = options.initialDelayMs ?? 500;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.recoveryRate = options.recoveryRate ?? 0.9;
    this.maxConsecutive429 = options.maxConsecutive429 ?? 5;
  }

  /**
   * Wait before next request. Returns false if too many consecutive 429s.
   */
  async wait(): Promise<boolean> {
    if (this.consecutive429 >= this.maxConsecutive429) {
      getLogger().warn({
        consecutive429: this.consecutive429,
        currentDelay: this.currentDelay,
      }, 'AdaptiveThrottle: too many 429s, stopping');
      return false;
    }

    const jitter = this.currentDelay * (0.5 + Math.random() * 0.5);
    const waitMs = Math.min(jitter, this.maxDelay);
    await new Promise(r => setTimeout(r, waitMs));
    this.totalRequests++;
    return true;
  }

  /**
   * Report a response status code to adjust the delay.
   */
  reportStatus(statusCode: number): void {
    if (statusCode === 429 || statusCode === 503) {
      this.consecutive429++;
      this.total429s++;
      this.consecutiveSuccess = 0;
      this.currentDelay = Math.min(
        this.currentDelay * this.backoffMultiplier,
        this.maxDelay,
      );
      getLogger().debug({
        statusCode,
        newDelay: this.currentDelay,
        consecutive: this.consecutive429,
      }, 'AdaptiveThrottle: backing off');
    } else if (statusCode >= 200 && statusCode < 300) {
      this.consecutiveSuccess++;
      this.consecutive429 = 0;
      if (this.consecutiveSuccess >= 5 && this.currentDelay > this.minDelay) {
        this.currentDelay = Math.max(
          this.currentDelay * this.recoveryRate,
          this.minDelay,
        );
        this.consecutiveSuccess = 0;
        getLogger().debug({
          newDelay: this.currentDelay,
        }, 'AdaptiveThrottle: recovering');
      }
    }
  }

  /** Report a non-HTTP error (network failure, timeout). */
  reportError(): void {
    this.consecutive429++;
    this.currentDelay = Math.min(
      this.currentDelay * 1.5,
      this.maxDelay,
    );
  }

  /** Reset to initial state. */
  reset(): void {
    this.currentDelay = 500;
    this.consecutive429 = 0;
    this.consecutiveSuccess = 0;
  }

  getStats() {
    return {
      currentDelay: this.currentDelay,
      consecutive429: this.consecutive429,
      totalRequests: this.totalRequests,
      total429s: this.total429s,
    };
  }
}
