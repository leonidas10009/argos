import { getLogger } from '../utils/logger';

export class ProxyRotator {
  private proxies: string[];
  private index = 0;
  private failures = new Map<string, number>();
  private maxFailures: number;

  constructor(proxies: string[] = [], maxFailures = 3) {
    this.proxies = proxies;
    this.maxFailures = maxFailures;
  }

  add(proxy: string): void {
    if (!this.proxies.includes(proxy)) {
      this.proxies.push(proxy);
    }
  }

  remove(proxy: string): void {
    this.proxies = this.proxies.filter((p) => p !== proxy);
    this.failures.delete(proxy);
  }

  get(): string | null {
    const log = getLogger();
    const available = this.proxies.filter(
      (p) => (this.failures.get(p) || 0) < this.maxFailures,
    );

    if (available.length === 0) {
      log.warn('No proxies available');
      return null;
    }

    this.index = this.index % available.length;
    const proxy = available[this.index];

    if (!proxy) {
      return null;
    }

    this.index = (this.index + 1) % available.length;
    log.debug({ proxy }, 'Proxy selected');
    return proxy;
  }

  markFailure(proxy: string): void {
    const count = (this.failures.get(proxy) || 0) + 1;
    this.failures.set(proxy, count);
    getLogger().warn({ proxy, failures: count }, 'Proxy marked as failed');

    if (count >= this.maxFailures) {
      getLogger().error({ proxy }, 'Proxy disabled due to max failures');
    }
  }

  markSuccess(proxy: string): void {
    this.failures.set(proxy, 0);
  }

  get count(): number {
    return this.proxies.length;
  }

  get available(): number {
    return this.proxies.filter(
      (p) => (this.failures.get(p) || 0) < this.maxFailures,
    ).length;
  }
}
