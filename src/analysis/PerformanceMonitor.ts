import type { Page } from 'puppeteer';
import { getLogger } from '../utils/logger';

export interface ResourceSnapshot {
  timestamp: number;
  elapsedMs: number;
  pageUrl: string;
  domNodes: number;
  iframesCount: number;
  requestsCount: number;
  jsHeapMB: number;
  cpuUsage?: number;
}

export interface PerformanceReport {
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  snapshots: ResourceSnapshot[];
  summary: {
    avgDomNodes: number;
    avgJsHeapMB: number;
    peakJsHeapMB: number;
    totalRequests: number;
    pagesVisited: number;
    uniqueUrlsExtracted: number;
  };
}

export class PerformanceMonitor {
  private snapshots: ResourceSnapshot[] = [];
  private startTime = 0;
  private totalRequests = 0;
  private pagesVisited = 0;
  private uniqueUrls = 0;

  start() {
    this.startTime = Date.now();
    this.snapshots = [];
    this.totalRequests = 0;
    this.pagesVisited = 0;
    this.uniqueUrls = 0;
    getLogger().info('Performance monitoring started');
  }

  async snapshot(page: Page, label: string) {
    try {
      const metrics = await page.evaluate(`(function() {
        return {
          domNodes: document.querySelectorAll('*').length,
          iframes: document.querySelectorAll('iframe').length
        };
      })()`);

      const jsHeap = (process.memoryUsage?.() || { heapUsed: 0 }).heapUsed / 1024 / 1024;

      this.snapshots.push({
        timestamp: Date.now(),
        elapsedMs: Date.now() - this.startTime,
        pageUrl: label,
        domNodes: (metrics as Record<string, number>).domNodes || 0,
        iframesCount: (metrics as Record<string, number>).iframes || 0,
        requestsCount: this.totalRequests,
        jsHeapMB: Math.round(jsHeap * 100) / 100,
      });
    } catch {
      // snapshot failed silently
    }
  }

  trackRequest() {
    this.totalRequests++;
  }

  trackPageVisit() {
    this.pagesVisited++;
  }

  trackUrls(count: number) {
    this.uniqueUrls += count;
  }

  report(): PerformanceReport {
    const endTime = Date.now();
    const domNodes = this.snapshots.map(s => s.domNodes);
    const heapSizes = this.snapshots.map(s => s.jsHeapMB);

    return {
      startTime: this.startTime,
      endTime,
      totalDurationMs: endTime - this.startTime,
      snapshots: this.snapshots,
      summary: {
        avgDomNodes: Math.round(domNodes.reduce((a, b) => a + b, 0) / (domNodes.length || 1)),
        avgJsHeapMB: Math.round((heapSizes.reduce((a, b) => a + b, 0) / (heapSizes.length || 1)) * 100) / 100,
        peakJsHeapMB: Math.round(Math.max(...heapSizes, 0) * 100) / 100,
        totalRequests: this.totalRequests,
        pagesVisited: this.pagesVisited,
        uniqueUrlsExtracted: this.uniqueUrls,
      },
    };
  }

  printReport() {
    const r = this.report();
    const log = getLogger();

    log.info('=== PERFORMANCE REPORT ===');
    log.info({ duration: r.totalDurationMs + 'ms' }, 'Total time');
    log.info({ pages: r.summary.pagesVisited }, 'Pages visited');
    log.info({ requests: r.summary.totalRequests }, 'Network requests');
    log.info({ urls: r.summary.uniqueUrlsExtracted }, 'Unique URLs extracted');
    log.info({ avgDom: r.summary.avgDomNodes }, 'Avg DOM nodes');
    log.info({ avgHeap: r.summary.avgJsHeapMB + 'MB', peak: r.summary.peakJsHeapMB + 'MB' }, 'Memory (avg/peak)');

    if (r.snapshots.length > 0) {
      log.info('--- Timeline ---');
      for (const s of r.snapshots) {
        log.info({
          elapsed: s.elapsedMs + 'ms',
          dom: s.domNodes,
          heap: s.jsHeapMB + 'MB',
          iframes: s.iframesCount,
          url: s.pageUrl.slice(0, 60),
        }, 'Snapshot');
      }
    }

    return r;
  }
}
