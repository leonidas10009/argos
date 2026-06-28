import { getLogger } from '../utils/logger';
import { getHealthMonitor } from './HealthMonitor';

interface WatchdogConfig {
  warningPercent: number;
  criticalPercent: number;
  checkIntervalMs: number;
}

export class MemoryWatchdog {
  private config: WatchdogConfig;
  private interval: ReturnType<typeof setInterval> | null = null;
  private caches: Array<{ name: string; clear: () => void }> = [];
  private onCritical: (() => void) | null = null;

  constructor(config?: Partial<WatchdogConfig>) {
    this.config = {
      warningPercent: config?.warningPercent ?? 70,
      criticalPercent: config?.criticalPercent ?? 90,
      checkIntervalMs: config?.checkIntervalMs ?? 30_000,
    };
  }

  registerCache(name: string, clear: () => void): void {
    this.caches.push({ name, clear });
  }

  onCriticalCallback(fn: () => void): void {
    this.onCritical = fn;
  }

  start(): void {
    if (this.interval) return;
    const log = getLogger();
    log.info({ warningPercent: this.config.warningPercent, criticalPercent: this.config.criticalPercent }, 'Memory watchdog started');

    this.interval = setInterval(() => {
      this.check();
    }, this.config.checkIntervalMs);
    this.interval.unref();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      getLogger().info('Memory watchdog stopped');
    }
  }

  check(): { percent: number; action: string } {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const percent = Math.round((mem.heapUsed / mem.heapTotal) * 100);

    const log = getLogger();
    log.debug({ heapUsedMB, heapTotalMB, percent }, 'Memory check');

    if (percent >= this.config.criticalPercent) {
      log.warn({ percent, heapUsedMB, heapTotalMB }, 'CRITICAL: clearing all caches');
      this.clearAllCaches();
      if (this.onCritical) {
        log.error({ percent }, 'CRITICAL: triggering force shutdown');
        this.onCritical();
      }
      return { percent, action: 'critical' };
    }

    if (percent >= this.config.warningPercent) {
      log.info({ percent, heapUsedMB, heapTotalMB }, 'WARNING: clearing caches');
      this.clearAllCaches();
      try {
        const pruned = getHealthMonitor().prune(15 * 60 * 1000);
        log.debug({ pruned }, 'Pruned stale health entries');
      } catch { /* HealthMonitor may not be ready */ }
      if ((globalThis as Record<string, unknown>).gc) {
        ((globalThis as Record<string, unknown>).gc as () => void)();
      }
      return { percent, action: 'warning' };
    }

    return { percent, action: 'ok' };
  }

  private clearAllCaches(): void {
    for (const cache of this.caches) {
      try {
        cache.clear();
      } catch { /* ignore */ }
    }
  }
}
