import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../utils/logger';
import type { EngineName, EngineStats, ProviderStats } from '../types';

interface EngineRecord {
  successes: number;
  failures: number;
  totalDuration: number;
  avgDuration: number;
  phases: Record<string, { successes: number; failures: number }>;
}

interface ProviderData {
  totalAttempts: number;
  successCount: number;
  lastDuration: number;
  engines: Record<string, EngineRecord>;
  selectors: Record<string, { successes: number; failures: number }>;
}

const PERSIST_PATH = join(process.cwd(), '.provider-memory.json');

const ENGINE_NAMES: EngineName[] = ['static', 'dynamic', 'intelligent'];

export class ProviderMemory {
  private providers = new Map<string, ProviderData>();
  private persistPath: string;

  constructor(persistPath?: string) {
    this.persistPath = persistPath || PERSIST_PATH;
    this.load();
  }

  recordEngineAttempt(
    providerName: string,
    engine: EngineName,
    phase: string,
    success: boolean,
    durationMs: number,
    resultsCount: number,
  ): void {
    if (!this.providers.has(providerName)) {
      this.providers.set(providerName, this.emptyProvider());
    }
    const p = this.providers.get(providerName)!;
    p.totalAttempts++;
    if (success) p.successCount++;
    if (durationMs) p.lastDuration = durationMs;

    if (!p.engines[engine]) {
      p.engines[engine] = { successes: 0, failures: 0, totalDuration: 0, avgDuration: 0, phases: {} };
    }
    const e = p.engines[engine];
    if (success) e.successes++;
    else e.failures++;
    e.totalDuration += durationMs || 0;
    e.avgDuration = Math.round(e.totalDuration / (e.successes + e.failures));

    if (!e.phases[phase]) {
      e.phases[phase] = { successes: 0, failures: 0 };
    }
    if (success) e.phases[phase].successes++;
    else e.phases[phase].failures++;

    // Cross-feed into SessionMemory for domain-level Bayesian learning
    if (success && resultsCount > 0) {
      try {
        const { getSessionMemory } = require('./SessionMemory');
        const session = getSessionMemory();
        session.recordAttempt(
          engine,
          'provider',
          phase,
          true,
          resultsCount,
          [],
          providerName,
        );
      } catch { /* SessionMemory may not be initialized yet */ }
    }

    this.autoSave();
  }

  recordSelectorAttempt(providerName: string, selector: string, phase: string, success: boolean): void {
    if (!this.providers.has(providerName)) {
      this.providers.set(providerName, this.emptyProvider());
    }
    const p = this.providers.get(providerName)!;
    if (!p.selectors[selector]) {
      p.selectors[selector] = { successes: 0, failures: 0 };
    }
    if (success) p.selectors[selector].successes++;
    else p.selectors[selector].failures++;
  }

  getEngineOrder(providerName: string): EngineName[] {
    const p = this.providers.get(providerName);
    if (!p || Object.keys(p.engines).length === 0) {
      return ['static', 'intelligent', 'dynamic'];
    }

    const scored = Object.entries(p.engines).map(([name, stats]) => {
      const total = stats.successes + stats.failures;
      const rate = total > 0 ? stats.successes / total : 0;
      const confidence = Math.min(total / 5, 1);
      const speedPenalty = name === 'static' ? 0 : name === 'intelligent' ? 0.03 : 0.06;
      return {
        engine: name as EngineName,
        score: rate * confidence - speedPenalty,
        rate,
        confidence,
        successes: stats.successes,
        failures: stats.failures,
        avgDuration: stats.avgDuration,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const order = scored.map(s => s.engine);

    for (const engine of ENGINE_NAMES) {
      if (!order.includes(engine)) order.push(engine);
    }

    return order;
  }

  getProviderStats(providerName: string): ProviderStats | null {
    const p = this.providers.get(providerName);
    if (!p) return null;

    const engines: Record<string, EngineStats> = {};
    for (const [name, e] of Object.entries(p.engines)) {
      const total = e.successes + e.failures;
      const successRate = total > 0 ? Math.round(e.successes / total * 100) : 0;
      const confidence = Math.min(total / 5, 1);
      engines[name] = {
        engine: name as EngineName,
        successRate,
        confidence,
        successes: e.successes,
        failures: e.failures,
        avgDuration: e.avgDuration,
        phases: e.phases || {},
      };
    }

    return {
      name: providerName,
      totalAttempts: p.totalAttempts,
      successRate: p.totalAttempts > 0 ? Math.round(p.successCount / p.totalAttempts * 100) : 0,
      lastDuration: p.lastDuration,
      recommendedOrder: this.getEngineOrder(providerName),
      engines,
    };
  }

  getBestSelectors(providerName: string): { selector: string; successRate: number; attempts: number }[] {
    const p = this.providers.get(providerName);
    if (!p) return [];
    return Object.entries(p.selectors)
      .map(([sel, s]) => ({
        selector: sel,
        successRate: (s.successes + s.failures) > 0 ? s.successes / (s.successes + s.failures) : 0,
        attempts: s.successes + s.failures,
      }))
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 10);
  }

  getAllStats(): ProviderStats[] {
    const stats: ProviderStats[] = [];
    for (const [name] of this.providers) {
      const s = this.getProviderStats(name);
      if (s) stats.push(s);
    }
    return stats.sort((a, b) => b.successRate - a.successRate);
  }

  getTopProviders(minAttempts = 3): ProviderStats[] {
    return this.getAllStats().filter(s => s.totalAttempts >= minAttempts);
  }

  getFailingProviders(minAttempts = 3, threshold = 30): ProviderStats[] {
    return this.getAllStats().filter(s => s.totalAttempts >= minAttempts && s.successRate < threshold);
  }

  forceSave(): void {
    try {
      const data: Record<string, ProviderData> = {};
      for (const [name, p] of this.providers) {
        data[name] = { ...p };
      }
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch { /* silent */ }
  }

  private load(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, ProviderData>;
      for (const [name, p] of Object.entries(data)) {
        this.providers.set(name, {
          totalAttempts: p.totalAttempts || 0,
          successCount: p.successCount || 0,
          lastDuration: p.lastDuration || 0,
          engines: p.engines || {},
          selectors: p.selectors || {},
        });
      }
      getLogger().debug({ providers: this.providers.size }, 'ProviderMemory loaded');
    } catch {
      getLogger().warn('Failed to load ProviderMemory');
    }
  }

  private autoSave(): void {
    let total = 0;
    for (const p of this.providers.values()) total += p.totalAttempts;
    if (total % 10 === 0) {
      // Dual persistence: save both provider AND session memory
      try {
        const { getSessionMemory } = require('./SessionMemory');
        getSessionMemory().forceSave();
      } catch { /* SessionMemory may not be ready */ }
      this.forceSave();
    }
  }

  private emptyProvider(): ProviderData {
    return {
      totalAttempts: 0,
      successCount: 0,
      lastDuration: 0,
      engines: {},
      selectors: {},
    };
  }
}

let instance: ProviderMemory | null = null;

export function getProviderMemory(): ProviderMemory {
  if (!instance) instance = new ProviderMemory();
  return instance;
}

export function resetProviderMemory(): void {
  if (instance) {
    instance.forceSave();
    instance = null;
  }
}
