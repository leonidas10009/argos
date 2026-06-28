import { getSessionMemory } from './SessionMemory';
import { getProviderMemory } from './ProviderMemory';
import { getLogger } from '../utils/logger';
import type { HealthReport } from '../types';

export interface BayesianScore {
  score: number;
  successes: number;
  total: number;
  confidence: number;
}

export interface HealthSummary {
  status: 'ok' | 'degraded' | 'critical';
  uptime: number;
  memory: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
    percent: number;
  };
  sessionMemory: {
    totalAttempts: number;
    successRate: number;
    domains: number;
    patterns: number;
    chains: number;
  };
  providers: {
    total: number;
    healthy: number;
    degraded: number;
    failed: number;
  };
  details: HealthReport[];
}

export class HealthMonitor {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  getSummary(): HealthSummary {
    const mem = process.memoryUsage();
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const percent = Math.round((mem.heapUsed / mem.heapTotal) * 100);

    const session = getSessionMemory();
    const providerMem = getProviderMemory();
    const providerStats = providerMem.getAllStats();
    const sessionScores = session.getAdaptiveScores();

    const details = providerStats.map(s => ({
      provider: s.name,
      status: this.statusFromRate(s.successRate),
      uptime: Date.now() - this.startTime,
      attempts: s.totalAttempts,
      successRate: s.successRate,
      circuitState: 'closed' as const, // será actualizado externamente
      lastCheck: Date.now(),
    }));

    const healthy = details.filter(d => d.status === 'healthy').length;
    const degraded = details.filter(d => d.status === 'degraded').length;
    const failed = details.filter(d => d.status === 'failed').length;

    const overallStatus: HealthSummary['status'] =
      failed > healthy ? 'critical' :
      failed > 0 || degraded > healthy ? 'degraded' :
      'ok';

    return {
      status: overallStatus,
      uptime: Date.now() - this.startTime,
      memory: { heapUsedMB, heapTotalMB, rssMB, percent },
      sessionMemory: {
        totalAttempts: sessionScores.totalAttempts ?? 0,
        successRate: sessionScores.totalAttempts
          ? Math.round((sessionScores.successCount ?? 0) / sessionScores.totalAttempts * 100)
          : 0,
        domains: Object.keys(sessionScores.typeBoosts || {}).length,
        patterns: (sessionScores.topPatterns || []).length,
        chains: Object.keys(sessionScores.urlChains || {}).length,
      },
      providers: { total: details.length, healthy, degraded, failed },
      details,
    };
  }

  getProviderScore(providerName: string): BayesianScore | null {
    const session = getSessionMemory();
    const fp = session.getDomainFingerprint(providerName);
    if (!fp) return null;

    let successes = 0;
    let total = 0;
    for (const [, count] of fp.successfulClasses) { successes += count; total += count; }
    for (const [, count] of fp.failedClasses) { total += count; }

    const score = total > 0 ? (successes + 1) / (total + 2) : 0.5;
    const confidence = Math.min(total / 5, 1);

    return { score, successes, total, confidence };
  }

  predictSuccess(providerName: string, elementType: string, elementClass: string): number {
    const session = getSessionMemory();
    const pred = session.predictSuccess(elementType, elementClass, providerName);
    return (pred.estimatedSuccess + pred.confidence) / 2;
  }

  isKnownContainerDomain(domain: string): boolean {
    return getSessionMemory().isKnownContainerDomain(domain);
  }

  prune(maxAgeMs: number): number {
    let pruned = 0;
    const now = Date.now();
    const memory = getProviderMemory();
    const stats = memory.getAllStats();

    for (const s of stats) {
      if (s.lastDuration > 0 && (now - this.startTime - s.lastDuration) > maxAgeMs) {
        pruned++;
      }
    }
    return pruned;
  }

  private statusFromRate(rate: number): HealthReport['status'] {
    if (rate >= 60) return 'healthy';
    if (rate >= 30) return 'degraded';
    return 'failed';
  }
}

let instance: HealthMonitor | null = null;

export function getHealthMonitor(): HealthMonitor {
  if (!instance) instance = new HealthMonitor();
  return instance;
}
