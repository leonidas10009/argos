import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getLogger } from '../utils/logger';
import type { ProviderConfig } from '../types';
import type { ExportableProfile, SiteProfile, NavigationMap, LearnedKnowledgeBase } from './learning-types';
import { ProfileBuilder } from './ProfileBuilder';
import { NavigationMapper } from './NavigationMapper';
import { getLearnedKB } from './LearnedKnowledgeBase';
import type { SmartScrapeResult } from './AutonomousScraper';

export class ProfileExporter {
  private profiles: Map<string, SiteProfile> = new Map();
  private navMaps: Map<string, NavigationMap> = new Map();
  private providers: ProviderConfig[] = [];
  private builder = new ProfileBuilder();
  private mapper = new NavigationMapper();

  /**
   * Process a scrape result — builds site profile, navigation map,
   * optionally generates a provider config, and feeds the learned KB.
   */
  processResult(result: SmartScrapeResult, domain: string, baseUrl: string): void {
    // Build site profile
    const profile = this.builder.buildSiteProfile(result, domain);
    const existing = this.profiles.get(domain);
    if (existing) {
      this.profiles.set(domain, this.mergeProfile(existing, profile));
    } else {
      this.profiles.set(domain, profile);
    }

    // Build navigation map
    const navMap = this.mapper.buildMap(result, result.url);
    const existingNav = this.navMaps.get(domain);
    if (existingNav) {
      this.navMaps.set(domain, this.mapper.merge(existingNav, navMap));
    } else {
      this.navMaps.set(domain, navMap);
    }

    // Generate provider config if successful
    if (result.serverCatalog.length > 0) {
      const config = this.builder.generateProviderConfig(result, domain, baseUrl);
      if (config && !this.providers.find(p => p.name === config.name)) {
        this.providers.push(config);
      }
    }

    // Feed learned KB with selectors
    const learned = getLearnedKB();
    for (const step of result.steps) {
      if (step.action === 'navigate' || step.action === 'group' || step.action === 'dive') {
        learned.addSelector(step.target, domain, step.action, step.result?.success || false);
      }
    }

    getLogger().info({ domain, profile: Object.keys(profile.pageTypes).join(',') }, 'ProfileExporter: processed');
  }

  /**
   * Export everything to a portable JSON-serializable object.
   */
  export(): ExportableProfile {
    const learnedKB = getLearnedKB().getData();
    const siteProfiles: Record<string, SiteProfile> = {};
    for (const [domain, profile] of this.profiles) siteProfiles[domain] = profile;

    const navigationMaps: Record<string, NavigationMap> = {};
    for (const [domain, map] of this.navMaps) navigationMaps[domain] = map;

    return {
      version: 1,
      exportedAt: Date.now(),
      providers: this.providers,
      siteProfiles,
      navigationMaps,
      learnedKB,
    };
  }

  /**
   * Save export to disk.
   */
  saveToFile(path: string): void {
    const data = this.export();
    writeFileSync(path, JSON.stringify(data, null, 2));
    getLogger().info({ path, providers: data.providers.length, profiles: Object.keys(data.siteProfiles).length }, 'ProfileExporter: saved');
  }

  /**
   * Import a previously exported profile.
   */
  import(data: ExportableProfile): void {
    if (data.providers) {
      for (const p of data.providers) {
        if (!this.providers.find(e => e.name === p.name)) {
          this.providers.push(p);
        }
      }
    }
    if (data.siteProfiles) {
      for (const [domain, profile] of Object.entries(data.siteProfiles)) {
        const existing = this.profiles.get(domain);
        this.profiles.set(domain, existing ? this.mergeProfile(existing, profile) : profile);
      }
    }
    if (data.navigationMaps) {
      for (const [domain, map] of Object.entries(data.navigationMaps)) {
        const existing = this.navMaps.get(domain);
        if (existing) {
          this.navMaps.set(domain, this.mapper.merge(existing, map));
        } else {
          this.navMaps.set(domain, map);
        }
      }
    }
    if (data.learnedKB) {
      getLearnedKB().import(data.learnedKB);
    }
    getLogger().info({ providers: data.providers?.length || 0 }, 'ProfileExporter: imported');
  }

  /**
   * Load export from disk.
   */
  loadFromFile(path: string): boolean {
    try {
      if (!existsSync(path)) return false;
      const raw = readFileSync(path, 'utf-8');
      const data = JSON.parse(raw) as ExportableProfile;
      this.import(data);
      return true;
    } catch (err) {
      getLogger().warn({ error: (err as Error).message, path }, 'ProfileExporter: load failed');
      return false;
    }
  }

  /** Get all accumulated providers. */
  getProviders(): ProviderConfig[] {
    return [...this.providers];
  }

  /** Get site profile for a domain. */
  getProfile(domain: string): SiteProfile | undefined {
    return this.profiles.get(domain);
  }

  /** Get navigation map for a domain. */
  getNavigationMap(domain: string): NavigationMap | undefined {
    return this.navMaps.get(domain);
  }

  /** Clear all accumulated data. */
  clear(): void {
    this.profiles.clear();
    this.navMaps.clear();
    this.providers = [];
  }

  private mergeProfile(existing: SiteProfile, incoming: SiteProfile): SiteProfile {
    const pageTypes = { ...existing.pageTypes };
    for (const [type, data] of Object.entries(incoming.pageTypes)) {
      if (pageTypes[type]) {
        pageTypes[type]!.count += data.count;
        pageTypes[type]!.confidence = Math.max(pageTypes[type]!.confidence, data.confidence);
      } else {
        pageTypes[type] = data;
      }
    }

    const selectors = [...existing.bestSelectors];
    for (const s of incoming.bestSelectors) {
      const existingSel = selectors.find(e => e.selector === s.selector);
      if (existingSel) {
        existingSel.successRate = (existingSel.successRate * existingSel.attempts + s.successRate * s.attempts) / (existingSel.attempts + s.attempts);
        existingSel.attempts += s.attempts;
      } else {
        selectors.push(s);
      }
    }
    selectors.sort((a, b) => b.successRate - a.successRate);

    const embedDomains = [...new Set([...existing.embedDomains, ...incoming.embedDomains])];
    const searchInputs = [...existing.searchInputs];
    for (const si of incoming.searchInputs) {
      if (!searchInputs.find(e => e.selector === si.selector)) searchInputs.push(si);
    }

    const urlPatterns = [...existing.urlPatterns];
    for (const up of incoming.urlPatterns) {
      const existingUp = urlPatterns.find(e => e.pattern === up.pattern);
      if (existingUp) existingUp.count += up.count;
      else urlPatterns.push(up);
    }

    return {
      ...existing,
      pageTypes,
      bestSelectors: selectors.slice(0, 20),
      embedDomains,
      searchInputs,
      urlPatterns: urlPatterns.slice(0, 30),
      visits: existing.visits + incoming.visits,
      lastVisit: Math.max(existing.lastVisit, incoming.lastVisit),
      recommendedStrategy: incoming.visits > existing.visits ? incoming.recommendedStrategy : existing.recommendedStrategy,
    };
  }
}
