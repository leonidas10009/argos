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

  if (!rawServers || !Array.isArray(rawServers)) {
    log.debug('No server data found in scrape result');
    return [];
  }

  const servers: OldServerEntry[] = rawServers.map((s) => ({
    name: (s['name'] as string) || (s['nombre'] as string) || '',
    url: (s['url'] as string) || (s['link'] as string) || (s['href'] as string) || '',
    status: (s['status'] as string) || '',
    players: (s['players'] as string) || '',
    version: (s['version'] as string) || '',
  }));

  log.info({ count: servers.length }, 'Servers extracted');
  return servers;
}
