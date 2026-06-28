import type { ProviderConfig } from '../types';
import { getLogger } from '../utils/logger';

const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    name: 'animejara',
    title: 'AnimeJara',
    baseUrl: 'https://animejara.com',
    language: 'ES',
    categories: ['anime'],
    active: true,
    search: {
      url: '/search?q={query}',
      itemSelector: '.card, .anime-item, article',
      titleSelector: '.card-title, h3, .title',
      linkSelector: 'a[href]',
    },
    episodes: {
      type: 'none',
    },
    videos: {
      type: 'onclick',
      containerSelector: '.server-list, #lista-server',
      iframeSelector: 'iframe',
    },
  },
  {
    name: 'tioanime',
    title: 'TioAnime',
    baseUrl: 'https://tioanime.com',
    language: 'ES',
    categories: ['anime'],
    active: true,
    search: {
      url: '/directorio?q={query}',
      itemSelector: '.episode, .anime-item, article',
      titleSelector: '.title, h3, a',
      linkSelector: 'a[href]',
    },
    episodes: {
      type: 'jsvar',
      pattern: '/ver/',
    },
    videos: {
      type: 'jsvar',
      containerSelector: '.player-container',
    },
  },
  {
    name: 'animeflv',
    title: 'AnimeFLV',
    baseUrl: 'https://www3.animeflv.net',
    language: 'ES',
    categories: ['anime'],
    active: true,
    search: {
      url: '/browse?q={query}',
      itemSelector: '.Anime, .anime-item, article',
      titleSelector: '.Title, h3, a',
      linkSelector: 'a[href]',
    },
    episodes: {
      type: 'url',
      pattern: '/ver/',
    },
    videos: {
      type: 'jsvar',
      containerSelector: '.player-container',
    },
  },
  {
    name: 'jkanime',
    title: 'JKAnime',
    baseUrl: 'https://jkanime.net',
    language: 'ES',
    categories: ['anime'],
    active: true,
    search: {
      url: '/buscar/{query}',
      itemSelector: '.anime-item, article, .list-item',
      titleSelector: '.title, h3, a',
      linkSelector: 'a[href]',
    },
    episodes: {
      type: 'url',
      pattern: '/ver/',
    },
    videos: {
      type: 'jkplayer',
      containerSelector: '.player-wrapper',
      iframeSelector: 'iframe',
    },
  },
];

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
