import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../utils/logger';
import type { EmbedResult } from '../types';
import type { LearnedKnowledgeBase, LearnedDomainEntry, LearnedSelector, LearnedPattern } from './learning-types';
import type { URLClassification } from './SmartAnalyzer';

const PERSIST_PATH = join(process.cwd(), '.learned-kb.json');

export class LearnedKB {
  private data: LearnedKnowledgeBase;
  private persistPath: string;

  constructor(persistPath?: string) {
    this.persistPath = persistPath || PERSIST_PATH;
    this.data = this.load();
  }

  /**
   * Register a newly discovered domain from a successful embed resolution.
   */
  addDomain(domain: string, result: EmbedResult): void {
    const existing = this.data.domains[domain];
    if (existing) {
      existing.lastSeen = Date.now();
      existing.successCount++;
      existing.confidence = Math.min(1, existing.confidence + 0.05);
      if (result.method !== 'generic' && !existing.resolverMethod) {
        existing.resolverMethod = result.method;
      }
    } else {
      this.data.domains[domain] = {
        domain,
        type: this.inferType(result),
        resolverMethod: result.method !== 'generic' ? result.method : undefined,
        serverName: result.serverName,
        confidence: result.directUrl ? 0.6 : 0.2,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        successCount: result.directUrl ? 1 : 0,
      };
      this.data.totalDiscoveries++;
    }
    this.data.lastUpdated = Date.now();
    getLogger().debug({ domain, type: this.data.domains[domain]?.type }, 'LearnedKB: domain added');
  }

  /**
   * Register a successful selector from exploration.
   */
  addSelector(selector: string, domain: string, phase: string, success: boolean): void {
    const existing = this.data.selectors.find(s => s.selector === selector && s.domain === domain);
    if (existing) {
      existing.attempts++;
      if (success) existing.successRate = (existing.successRate * (existing.attempts - 1) + 1) / existing.attempts;
      else existing.successRate = (existing.successRate * (existing.attempts - 1)) / existing.attempts;
      existing.lastUsed = Date.now();
    } else {
      this.data.selectors.push({
        selector,
        domain,
        phase,
        successRate: success ? 1 : 0,
        attempts: 1,
        lastUsed: Date.now(),
      });
    }
  }

  /**
   * Register a discovered pattern from exploration.
   */
  addPattern(pattern: string, description: string, category: LearnedPattern['category'], example: string): void {
    const existing = this.data.patterns.find(p => p.pattern === pattern && p.category === category);
    if (existing) {
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      if (!existing.examples.includes(example)) existing.examples.push(example);
    } else {
      this.data.patterns.push({ pattern, description, confidence: 0.5, examples: [example], category });
    }
    this.data.lastUpdated = Date.now();
  }

  /**
   * Learn from a URL classification result — register domain if confidence is high.
   */
  learnFromClassification(domain: string, classification: URLClassification): void {
    if (classification.confidence < 70) return;

    const existing = this.data.domains[domain];
    if (!existing) {
      this.data.domains[domain] = {
        domain,
        type: classification.type as LearnedDomainEntry['type'],
        confidence: classification.confidence / 100,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        successCount: 0,
      };
      this.data.totalDiscoveries++;
      this.data.lastUpdated = Date.now();
    }
  }

  /**
   * Get learned domains matching a type filter.
   */
  getDomainsByType(type: string): LearnedDomainEntry[] {
    return Object.values(this.data.domains).filter(d => d.type === type);
  }

  /**
   * Get best selectors for a domain.
   */
  getSelectorsForDomain(domain: string, minSuccessRate = 0.5): LearnedSelector[] {
    return this.data.selectors
      .filter(s => s.domain === domain && s.successRate >= minSuccessRate)
      .sort((a, b) => b.successRate - a.successRate);
  }

  /**
   * Get patterns by category.
   */
  getPatternsByCategory(category: LearnedPattern['category']): LearnedPattern[] {
    return this.data.patterns
      .filter(p => p.category === category)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /** Get the full knowledge base. */
  getData(): LearnedKnowledgeBase {
    return { ...this.data, domains: { ...this.data.domains }, selectors: [...this.data.selectors], patterns: [...this.data.patterns] };
  }

  /** Import external knowledge. */
  import(data: Partial<LearnedKnowledgeBase>): void {
    if (data.domains) {
      for (const [domain, entry] of Object.entries(data.domains)) {
        if (!this.data.domains[domain] || entry.confidence > this.data.domains[domain]!.confidence) {
          this.data.domains[domain] = { ...this.data.domains[domain], ...entry };
        }
      }
    }
    if (data.selectors) {
      for (const s of data.selectors) {
        const existing = this.data.selectors.find(e => e.selector === s.selector && e.domain === s.domain);
        if (!existing) this.data.selectors.push(s);
      }
    }
    if (data.patterns) {
      for (const p of data.patterns) {
        const existing = this.data.patterns.find(e => e.pattern === p.pattern && e.category === p.category);
        if (!existing) this.data.patterns.push(p);
      }
    }
    this.data.lastUpdated = Date.now();
    getLogger().info({ importedDomains: Object.keys(data.domains || {}).length }, 'LearnedKB: imported');
  }

  /** Persist to disk. */
  save(): void {
    try {
      writeFileSync(this.persistPath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      getLogger().debug({ error: (err as Error).message }, 'LearnedKB: save failed');
    }
  }

  private load(): LearnedKnowledgeBase {
    try {
      if (!existsSync(this.persistPath)) return this.empty();
      const raw = readFileSync(this.persistPath, 'utf-8');
      return JSON.parse(raw) as LearnedKnowledgeBase;
    } catch {
      getLogger().warn('LearnedKB: load failed, starting fresh');
      return this.empty();
    }
  }

  private empty(): LearnedKnowledgeBase {
    return { domains: {}, selectors: [], patterns: [], totalDiscoveries: 0, lastUpdated: 0 };
  }

  private inferType(result: EmbedResult): LearnedDomainEntry['type'] {
    if (result.directUrl) {
      if (result.directUrl.includes('.m3u8')) return 'stream';
      if (result.directUrl.includes('.mp4')) return 'direct-video';
      return 'embed';
    }
    return 'embed';
  }
}

let instance: LearnedKB | null = null;

export function getLearnedKB(): LearnedKB {
  if (!instance) instance = new LearnedKB();
  return instance;
}

export function resetLearnedKB(): void {
  if (instance) {
    instance.save();
    instance = null;
  }
}
