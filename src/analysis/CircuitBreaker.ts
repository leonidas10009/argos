import type { CircuitState } from '../types';
import { getLogger } from '../utils/logger';

export class CircuitBreaker {
  private circuits = new Map<string, CircuitState>();
  private failureThreshold: number;
  private resetTimeoutMs: number;
  private halfOpenMax: number;

  constructor(failureThreshold = 5, resetTimeoutMs = 300_000, halfOpenMax = 2) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.halfOpenMax = halfOpenMax;
  }

  shouldSkip(provider: string): boolean {
    const state = this.getOrCreate(provider);
    if (state.state === 'open') {
      if (Date.now() - (state.openedAt || 0) > this.resetTimeoutMs) {
        state.state = 'half-open';
        getLogger().debug({ provider }, 'Circuit half-open, allowing probe');
        return false;
      }
      return true;
    }
    return false;
  }

  async execute<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    if (this.shouldSkip(provider)) {
      throw new CircuitOpenError(provider, this.circuits.get(provider)!.openedAt!);
    }

    try {
      const result = await fn();
      this.recordSuccess(provider);
      return result;
    } catch (err) {
      this.recordFailure(provider);
      throw err;
    }
  }

  recordSuccess(provider: string): void {
    const state = this.getOrCreate(provider);
    state.successes++;
    state.lastSuccess = Date.now();
    state.failures = 0;

    if (state.state === 'half-open') {
      if (state.successes >= this.halfOpenMax) {
        state.state = 'closed';
        state.openedAt = null;
        getLogger().info({ provider }, 'Circuit closed (recovered)');
      }
    }
  }

  recordFailure(provider: string): void {
    const state = this.getOrCreate(provider);
    state.failures++;
    state.lastFailure = Date.now();

    if (state.state === 'half-open') {
      state.state = 'open';
      state.openedAt = Date.now();
      getLogger().warn({ provider, failures: state.failures }, 'Circuit re-opened (half-open failed)');
    } else if (state.failures >= this.failureThreshold) {
      state.state = 'open';
      state.openedAt = Date.now();
      getLogger().warn({ provider, failures: state.failures }, 'Circuit opened');
    }
  }

  getState(provider: string): CircuitState {
    return this.getOrCreate(provider);
  }

  getAllStates(): CircuitState[] {
    return Array.from(this.circuits.values());
  }

  getFailingProviders(): string[] {
    return Array.from(this.circuits.entries())
      .filter(([, s]) => s.state === 'open')
      .map(([name]) => name);
  }

  getHealthyProviders(): string[] {
    return Array.from(this.circuits.entries())
      .filter(([, s]) => s.state === 'closed')
      .map(([name]) => name);
  }

  reset(provider: string): void {
    this.circuits.delete(provider);
    getLogger().info({ provider }, 'Circuit reset');
  }

  resetAll(): void {
    this.circuits.clear();
    getLogger().info('All circuits reset');
  }

  private getOrCreate(provider: string): CircuitState {
    if (!this.circuits.has(provider)) {
      this.circuits.set(provider, {
        provider,
        state: 'closed',
        failures: 0,
        successes: 0,
        lastFailure: 0,
        lastSuccess: 0,
        openedAt: null,
      });
    }
    return this.circuits.get(provider)!;
  }
}

export class CircuitOpenError extends Error {
  provider: string;
  openedAt: number;

  constructor(provider: string, openedAt: number) {
    super(`Circuit open for ${provider} (since ${new Date(openedAt).toISOString()})`);
    this.name = 'CircuitOpenError';
    this.provider = provider;
    this.openedAt = openedAt;
  }
}
