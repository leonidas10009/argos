import type { ProviderConfig } from '../types';
import { getLogger } from '../utils/logger';

const BUILTIN_PROVIDERS: ProviderConfig[] = [];

export class ProviderRegistry {
  private providers = new Map<string, ProviderConfig>();

  constructor() {
    for (const p of BUILTIN_PROVIDERS) {
      this.providers.set(p.name, { ...p });
    }
    getLogger().info({ count: this.providers.size }, 'ProviderRegistry initialized');
  }

  register(config: ProviderConfig): void {
    this.providers.set(config.name, { ...config });
  }

  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  get(name: string): ProviderConfig | undefined {
    return this.providers.get(name);
  }

  getAll(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  getActive(): ProviderConfig[] {
    return this.getAll().filter(p => p.active);
  }

  getByCategory(category: string): ProviderConfig[] {
    return this.getActive().filter(p => p.categories.includes(category));
  }

  getByLanguage(lang: string): ProviderConfig[] {
    return this.getActive().filter(p => p.language === lang);
  }

  count(): number {
    return this.providers.size;
  }

  names(): string[] {
    return Array.from(this.providers.keys());
  }

  importProviders(configs: ProviderConfig[]): number {
    let added = 0;
    for (const c of configs) {
      if (!this.providers.has(c.name)) {
        this.providers.set(c.name, { ...c });
        added++;
      }
    }
    return added;
  }

  exportProviders(): ProviderConfig[] {
    return this.getAll();
  }
}

let instance: ProviderRegistry | null = null;

export function getProviderRegistry(): ProviderRegistry {
  if (!instance) instance = new ProviderRegistry();
  return instance;
}
