import type { Page } from 'puppeteer';
import type { ScrapeResult, ServerEntry as OldServerEntry } from '../types';
import { getLogger } from '../utils/logger';

export interface ServerData {
  number: string;
  name: string;
  url: string;
}

export interface LanguageServers {
  language: string;
  title: string;
  servers: ServerData[];
  downloadUrl: string;
}

export interface ServerListResult {
  source: string;
  languages: LanguageServers[];
}

export function extractServers(result: ScrapeResult): OldServerEntry[] {
  const log = getLogger();

  if (!result.success || !result.data) return [];

  const data = result.data as Record<string, unknown>;
  const rawServers = data['servers'] as Record<string, unknown>[] | undefined;

  if (!rawServers || rawServers.length === 0) {
    log.warn('No servers found in scrape result');
    return [];
  }

  const servers: OldServerEntry[] = rawServers.map(raw => ({
    name: String(raw['name'] || raw['nombre'] || raw['text'] || 'Unknown'),
    url: String(raw['url'] || raw['link'] || raw['href'] || ''),
    status: raw['status'] ? String(raw['status']) : undefined,
    players: raw['players'] ? String(raw['players']) : undefined,
    version: raw['version'] ? String(raw['version']) : undefined,
    ...Object.fromEntries(
      Object.entries(raw).filter(([k]) => !['name', 'nombre', 'text', 'url', 'link', 'href', 'status', 'players', 'version'].includes(k)),
    ),
  }));

  log.info({ count: servers.length }, 'Servers extracted');
  return servers;
}

export async function extractServerList(page: Page): Promise<ServerListResult | null> {
  const result = await page.evaluate(`(function() {
    var lista = document.querySelector('#lista-server');
    if (!lista) return null;

    var _extractServers = function() {
      var items = lista.querySelectorAll('#logo-list li');
      var servers = [];
      for (var i = 0; i < items.length; i++) {
        var li = items[i];
        var onclick = li.getAttribute('onclick') || '';
        var urlMatch = onclick.match(/playVideo\\(["']([^"']+)["']\\)/);
        servers.push({
          number: (li.querySelector('.numero') || {}).textContent || '',
          name: (li.querySelector('.nombre-server') || {}).textContent || '',
          url: urlMatch ? urlMatch[1]! : ''
        });
      }

      var downloadBtn = lista.querySelector('#download-btn');
      var downloadUrl = '';
      if (downloadBtn) {
        var dOnclick = downloadBtn.getAttribute('onclick') || '';
        var dMatch = dOnclick.match(/window\\\\.open\\(['"]([^'"]+)['"]/);
        downloadUrl = dMatch ? dMatch[1]! : '';
      }

      var title = (lista.querySelector('h2') || {}).textContent || '';

      return { servers: servers, downloadUrl: downloadUrl, title: title };
    };

    var initial = _extractServers();

    var langButtons = document.querySelectorAll('.boton-idioma');
    var currentLang = '';
    for (var i = 0; i < langButtons.length; i++) {
      if (langButtons[i].className.indexOf('active') !== -1) {
        currentLang = (langButtons[i].textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 20);
        break;
      }
    }

    return {
      initial: initial,
      currentLang: currentLang || 'default',
      hasLanguages: langButtons.length > 1
    };
  })()`);

  if (!result) return null;

  const initialData = result as Record<string, unknown>;
  const initial = initialData.initial as Record<string, unknown> || {};

  const languages: LanguageServers[] = [{
    language: (initialData.currentLang as string) || 'default',
    title: (initial.title as string) || '',
    servers: (initial.servers as ServerData[]) || [],
    downloadUrl: (initial.downloadUrl as string) || '',
  }];

  if (initialData.hasLanguages) {
    const langButtons = await page.$$('.boton-idioma');
    for (let i = 0; i < langButtons.length; i++) {
      const btn = langButtons[i]!;
      const isActive = await page.evaluate(`(function() {
        var el = document.querySelectorAll('.boton-idioma')[${i}];
        return el ? el.className.indexOf('active') !== -1 : false;
      })()`);

      if (isActive) continue;

      await btn.click();
      await new Promise(r => setTimeout(r, 2500));

      const langData = await page.evaluate(`(function() {
        var lista = document.querySelector('#lista-server');
        if (!lista) return null;
        var items = lista.querySelectorAll('#logo-list li');
        var servers = [];
        for (var i = 0; i < items.length; i++) {
          var li = items[i];
          var onclick = li.getAttribute('onclick') || '';
          var urlMatch = onclick.match(/playVideo\\(["']([^"']+)["']\\)/);
          servers.push({
            number: (li.querySelector('.numero') || {}).textContent || '',
            name: (li.querySelector('.nombre-server') || {}).textContent || '',
            url: urlMatch ? urlMatch[1]! : ''
          });
        }
        var downloadBtn = lista.querySelector('#download-btn');
        var downloadUrl = '';
        if (downloadBtn) {
          var dOnclick = downloadBtn.getAttribute('onclick') || '';
          var dMatch = dOnclick.match(/window\\\\.open\\(['"]([^'"]+)['"]/);
          downloadUrl = dMatch ? dMatch[1]! : '';
        }
        var title = (lista.querySelector('h2') || {}).textContent || '';
        return { servers: servers, downloadUrl: downloadUrl, title: title };
      })()`);

      if (langData) {
        const langName = await page.evaluate(`(function() {
          var el = document.querySelectorAll('.boton-idioma')[${i}];
          return el ? (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 20) : 'lang_' + ${i};
        })()`);

        const ld = langData as Record<string, unknown>;

        languages.push({
          language: langName as string,
          title: (ld.title as string) || '',
          servers: (ld.servers as ServerData[]) || [],
          downloadUrl: (ld.downloadUrl as string) || '',
        });
      }
    }
  }

  return { source: 'lista-server', languages };
}
