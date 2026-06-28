import { randomUUID } from 'node:crypto';
import { getLogger } from '../utils/logger';
import type { BrowserInstance } from '../types';
import type { Browser } from 'puppeteer';

export interface LaunchBrowserFn {
  (): Promise<Browser>;
}

export interface PoolOptions {
  min: number;
  max: number;
  idleTimeoutMs: number;
}

export class BrowserPool {
  private instances: BrowserInstance[] = [];
  private waiting: Array<(instance: BrowserInstance) => void> = [];
  private launchFn: LaunchBrowserFn;
  private options: PoolOptions;
  private closed = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(launchFn: LaunchBrowserFn, options: PoolOptions) {
    this.launchFn = launchFn;
    this.options = options;
    this.startCleanup();
  }

  async acquire(): Promise<BrowserInstance> {
    if (this.closed) throw new Error('BrowserPool is closed');

    const free = this.instances.find((inst) => !inst.inUse && inst.browser.isConnected());
    if (free) {
      free.inUse = true;
      free.lastUsedAt = Date.now();
      free.usageCount++;
      getLogger().debug({ id: free.id, usageCount: free.usageCount }, 'Browser acquired from pool');
      return free;
    }

    if (this.instances.length < this.options.max) {
      const instance = await this.createInstance();
      instance.inUse = true;
      return instance;
    }

    return new Promise<BrowserInstance>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  async release(instance: BrowserInstance): Promise<void> {
    instance.inUse = false;
    instance.lastUsedAt = Date.now();
    getLogger().debug({ id: instance.id }, 'Browser released to pool');

    const next = this.waiting.shift();
    if (next) {
      instance.inUse = true;
      instance.usageCount++;
      next(instance);
    }
  }

  async destroyInstance(instance: BrowserInstance): Promise<void> {
    const idx = this.instances.indexOf(instance);
    if (idx !== -1) {
      this.instances.splice(idx, 1);
    }
    try {
      await instance.browser.close();
      getLogger().debug({ id: instance.id }, 'Browser instance destroyed');
    } catch {
      // browser might already be closed
    }
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    const log = getLogger();
    log.info({ count: this.instances.length }, 'Closing all browser instances');
    await Promise.allSettled(this.instances.map((inst) => inst.browser.close()));
    this.instances = [];
    this.waiting = [];
  }

  getStats(): { total: number; inUse: number; free: number; waiting: number } {
    return {
      total: this.instances.length,
      inUse: this.instances.filter((i) => i.inUse).length,
      free: this.instances.filter((i) => !i.inUse && i.browser.isConnected()).length,
      waiting: this.waiting.length,
    };
  }

  private async createInstance(): Promise<BrowserInstance> {
    const log = getLogger();
    log.info('Launching new browser instance');
    const browser = await this.launchFn();

    const instance: BrowserInstance = {
      id: randomUUID().slice(0, 8),
      browser,
      inUse: false,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      usageCount: 0,
    };

    this.instances.push(instance);
    log.info({ id: instance.id, total: this.instances.length }, 'Browser instance created');
    return instance;
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdle();
    }, 30_000);

    if (this.cleanupTimer && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  private cleanupIdle(): void {
    const now = Date.now();
    const toKeep = Math.max(this.options.min, 1);

    const idle = this.instances.filter(
      (inst) => !inst.inUse && now - inst.lastUsedAt > this.options.idleTimeoutMs,
    );

    const canRemove = this.instances.length - idle.length;
    const toRemove = idle.slice(0, Math.max(0, this.instances.length - toKeep));

    for (const inst of toRemove) {
      getLogger().debug({ id: inst.id, idleMs: now - inst.lastUsedAt }, 'Removing idle browser');
      this.destroyInstance(inst);
    }
  }
}
