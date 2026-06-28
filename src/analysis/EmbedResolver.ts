import { getLogger } from '../utils/logger';
import type { EmbedResult } from '../types';
import { SmartAnalyzer } from './SmartAnalyzer';
import { SessionMemory } from './SessionMemory';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EMBED_TIMEOUT = 10000;

async function fetchHtml(url: string, referer?: string, timeout = EMBED_TIMEOUT): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Referer': referer || url },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; } finally { clearTimeout(t); }
}

function getHostname(url: string): string { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
function cleanUrl(url: string): string { return url.startsWith('//') ? 'https:' + url : url; }

export class EmbedResolver {
  private cache = new Map<string, string | null>();
  private ai: SmartAnalyzer;
  private memory: SessionMemory;

  constructor() {
    this.ai = new SmartAnalyzer();
    this.memory = new SessionMemory();
  }

  async resolve(embedUrl: string, referer?: string): Promise<EmbedResult> {
    const start = Date.now();
    const host = getHostname(embedUrl);
    const serverName = this.ai.inferServerName(host);
    const log = getLogger();
    if (!embedUrl) return { embedUrl, directUrl: null, serverName, domain: host, method: 'none', durationMs: 0, error: 'empty_url' };
    const cached = this.cache.get(embedUrl);
    if (cached !== undefined) return { embedUrl, directUrl: cached, serverName, domain: host, method: 'cache', durationMs: Date.now() - start };

    log.debug({ embedUrl, host }, 'Resolving embed');

    const html = await fetchHtml(embedUrl, referer || embedUrl);
    if (!html) {
      this.cache.set(embedUrl, null);
      return { embedUrl, directUrl: null, serverName, domain: host, method: 'fetch', durationMs: Date.now() - start, error: 'fetch_failed' };
    }

    const directUrl = await this.resolveGeneric(embedUrl, html, referer);
    const finalUrl = directUrl ? cleanUrl(directUrl) : null;
    this.cache.set(embedUrl, finalUrl);
    this.recordAttempt(host, !!directUrl);
    return { embedUrl, directUrl: finalUrl, serverName, domain: host, method: directUrl ? (this.isDirectVideoUrl(directUrl) ? 'direct' : 'generic') : 'generic', durationMs: Date.now() - start, error: directUrl ? undefined : 'not_found' };
  }

  async resolveAll(urls: string[], referer?: string, concurrency = 4): Promise<EmbedResult[]> {
    const results: EmbedResult[] = [];
    for (let i = 0; i < urls.length; i += concurrency) {
      const chunk = urls.slice(i, i + concurrency);
      const batch = await Promise.all(chunk.map(u => this.resolve(u, referer)));
      results.push(...batch);
    }
    return results;
  }

  clearCache(): void { this.cache.clear(); }

  isDirectVideoUrl(url: string): boolean {
    if (!url) return false;
    if (/\.(m3u8|mp4|mkv|webm|avi|ts|mov)(\?|$)/i.test(url)) return true;
    if (/\/hls\//i.test(url)) return true;
    return false;
  }

  private async resolveGeneric(embedUrl: string, html: string, referer?: string): Promise<string | null> {
    const jwUrl = await this.resolveJWPlayer(html);
    if (jwUrl) return jwUrl.startsWith('//') ? 'https:' + jwUrl : jwUrl;

    for (const p of [/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i, /https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i]) {
      const match = html.match(p);
      if (match) return match[0]!;
    }

    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (iframeMatch) {
      const iframeUrl = iframeMatch[1]!.startsWith('//') ? 'https:' + iframeMatch[1]! : iframeMatch[1]!;
      if (iframeUrl !== embedUrl && iframeUrl !== referer) {
        const result = await this.resolve(iframeUrl, embedUrl);
        return result.directUrl;
      }
    }
    return null;
  }

  private async resolveJWPlayer(html: string): Promise<string | null> {
    const scripts: string[] = [];
    const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) { if (m[1]!.length > 10) scripts.push(m[1]!); }
    for (const script of scripts) {
      if (!script.includes('jwplayer') && !script.includes('sources') && !script.includes('playlist')) continue;
      const fileMatch = script.match(/["']file["']\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
      if (fileMatch) return fileMatch[1]!;
      const setupMatch = script.match(/jwplayer\s*\(\s*["'][^"']*["']\s*\)\s*\.\s*setup\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;/);
      if (setupMatch) {
        try {
          const config = JSON.parse(setupMatch[1]!.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3').replace(/'/g, '"'));
          if (config.sources && Array.isArray(config.sources)) {
            const sorted = config.sources.filter((s: any) => s.file).sort((a: any, b: any) => {
              const al = (a.label || '').match(/(\d+)/); const bl = (b.label || '').match(/(\d+)/);
              return (parseInt((bl && bl[1]) || '0') || 0) - (parseInt((al && al[1]) || '0') || 0);
            });
            if (sorted.length > 0) return sorted[0].file;
          }
          if (config.file) return config.file;
        } catch { /* ignore */ }
      }
    }
    return null;
  }

  private recordAttempt(host: string, success: boolean): void {
    try { this.memory.recordAttempt('host:' + host, 'embed', 'resolve', success, success ? 1 : 0, success ? ['embed'] : [], host); } catch { /* non-critical */ }
  }
}
