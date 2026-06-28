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
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Referer': referer || url,
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function getHostname(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); }
  catch { return ''; }
}

function cleanUrl(url: string): string {
  return url.startsWith('//') ? 'https:' + url : url;
}

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

    if (!embedUrl) {
      return { embedUrl, directUrl: null, serverName, domain: host, method: 'none', durationMs: 0, error: 'empty_url' };
    }

    const cached = this.cache.get(embedUrl);
    if (cached !== undefined) {
      return {
        embedUrl, directUrl: cached, serverName, domain: host,
        method: 'cache', durationMs: Date.now() - start,
      };
    }

    log.debug({ embedUrl, host }, 'Resolving embed');

    const rules: { pat: RegExp; resolver: (html: string, url: string) => Promise<string | null>; name: string }[] = [
      { pat: /streamwish|wish\.com|swdyu|sfastwish|wishembed|wishy|watchwish/i, resolver: this.resolveStreamwish, name: 'streamwish' },
      { pat: /filemoon|filemoon\.sx|kerapoxy|moplay|moon\.sx/i, resolver: this.resolveFilemoon, name: 'filemoon' },
      { pat: /uqload|uqload\.com/i, resolver: this.resolveJWPlayer, name: 'jwplayer' },
      { pat: /dood\.|doodstream|dood\.la|dood\.to|dood\.ws|dood\.wf|dood\.re|dood\.so|dood\.sh|dood\.pm|dooood|ds2play/i, resolver: this.resolveDoodstream, name: 'doodstream' },
      { pat: /mixdrop|mixdrop\.co|mixdrop\.ag|mixdrop\.vc|mixdrop\.to|mixdrop\.ch|mixdrop\.gl|mixdrp|mxdrop/i, resolver: this.resolveMixdrop, name: 'mixdrop' },
      { pat: /voe\.sx|voe\.su|vidvodo|voe\.to/i, resolver: this.resolveVoe, name: 'voe' },
      { pat: /vidhide|vidpro|vidguard|vid2v11/i, resolver: this.resolveVidhide, name: 'vidhide' },
      { pat: /ok\.ru|odnoklassniki/i, resolver: this.resolveOkRu, name: 'okru' },
      { pat: /streamtape|strtape|stape\.with|streamta\.to|stpete|tapecontent/i, resolver: this.resolveStreamtape, name: 'streamtape' },
      { pat: /mp4upload|mp4upload\.com/i, resolver: this.resolveMp4Upload, name: 'mp4upload' },
      { pat: /upstream\.to|uptostream|uptobox|upstreamcdn/i, resolver: this.resolveUpstream, name: 'upstream' },
      { pat: /netu\.tv|netutv|anavids|waaw\.tv|hqq\.tv|waaw1/i, resolver: this.resolveNetuTv, name: 'netu' },
      { pat: /vidmoly|vidmoly\.to|vidmoly\.net/i, resolver: this.resolveVidmoly, name: 'vidmoly' },
      { pat: /yourupload|youpload/i, resolver: this.resolveYourUpload, name: 'yourupload' },
      { pat: /filelions|filelions\.top/i, resolver: this.resolveJWPlayer, name: 'jwplayer' },
    ];

    let html: string | null = null;

    for (const rule of rules) {
      if (!rule.pat.test(host)) continue;

      html = await fetchHtml(embedUrl, referer || embedUrl);
      if (!html) {
        this.cache.set(embedUrl, null);
        return { embedUrl, directUrl: null, serverName, domain: host, method: rule.name, durationMs: Date.now() - start, error: 'fetch_failed' };
      }

      const directUrl = await rule.resolver(html, embedUrl);
      const result = cleanUrl(directUrl || '');
      this.cache.set(embedUrl, result || null);
      this.recordAttempt(host, !!directUrl);
      return {
        embedUrl, directUrl: directUrl ? cleanUrl(directUrl) : null,
        serverName, domain: host, method: rule.name,
        durationMs: Date.now() - start,
        error: directUrl ? undefined : 'not_found',
      };
    }

    html = await fetchHtml(embedUrl, referer || embedUrl);
    if (!html) {
      this.cache.set(embedUrl, null);
      return { embedUrl, directUrl: null, serverName, domain: host, method: 'generic', durationMs: Date.now() - start, error: 'fetch_failed' };
    }

    const genericUrl = await this.resolveGeneric(embedUrl, html, referer);
    const finalUrl = genericUrl ? cleanUrl(genericUrl) : null;
    this.cache.set(embedUrl, finalUrl);
    this.recordAttempt(host, !!genericUrl);
    return {
      embedUrl, directUrl: finalUrl, serverName, domain: host,
      method: 'generic', durationMs: Date.now() - start,
      error: genericUrl ? undefined : 'not_found',
    };
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

  clearCache(): void {
    this.cache.clear();
  }

  isDirectVideoUrl(url: string): boolean {
    if (!url) return false;
    if (/\.(m3u8|mp4|mkv|webm|avi|ts|mov)(\?|$)/i.test(url)) return true;
    if (/mp4upload\.com:\d+\/d\//i.test(url)) return true;
    if (/\/hls\//i.test(url)) return true;
    if (/streamtape\.com\/get_video/i.test(url)) return true;
    return false;
  }

  private async resolveStreamwish(html: string, _url: string): Promise<string | null> {
    const dataMatch = html.match(/const\s+_0x[a-f]*\s*=\s*(\{[^}]+\})/);
    if (dataMatch) {
      try {
        const obj = JSON.parse(dataMatch[1]!!.replace(/'/g, '"').replace(/(\w+):/g, '"$1":'));
        const keys = Object.values(obj);
        for (const key of keys) {
          if (typeof key === 'string' && key.length > 20 && /^[A-Za-z0-9+/=]+$/.test(key) && !key.startsWith('http')) {
            try { const d = Buffer.from(key, 'base64').toString(); if (d.includes('m3u8') || d.includes('mp4')) return d; } catch { /* continue */ }
          }
        }
      } catch { /* continue */ }
    }
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8) return m3u8[0]!!;
    const mp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
    if (mp4) return mp4[0]!!;
    return null;
  }

  private async resolveFilemoon(html: string, _url: string): Promise<string | null> {
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8) return m3u8[0]!!;
    const mp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
    if (mp4) return mp4[0]!!;
    const jsMatch = html.match(/"file"\s*:\s*"([^"]+\.(?:m3u8|mp4)[^"]*)"/i);
    if (jsMatch) return jsMatch[1]!;
    return null;
  }

  private async resolveDoodstream(html: string, url: string): Promise<string | null> {
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8) return m3u8[0]!!;
    const passMatch = html.match(/\$.get\('([^']+pass_md5[^']*)'/i);
    if (passMatch) {
      const tokenUrl = passMatch[1]!.startsWith('http') ? passMatch[1]! : new URL(passMatch[1]!, url).href;
      const tokenHtml = await fetchHtml(tokenUrl, url);
      if (tokenHtml) {
        const m = tokenHtml.match(/https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*/i);
        if (m) return m[0]!!;
        const parts = tokenHtml.split(' ');
        for (const p of parts) {
          if (p.match(/\.(?:m3u8|mp4)/i) && p.includes('http')) return p.replace(/^[^h]*/, '').trim();
        }
      }
    }
    const mp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
    if (mp4) return mp4[0]!!;
    return null;
  }

  private async resolveMixdrop(html: string, _url: string): Promise<string | null> {
    const refMatch = html.match(/MDCore\.ref\s*=\s*["']([^"']+)["']/);
    if (refMatch) {
      const ref = refMatch[1]!;
      const vHtml = await fetchHtml('https://mxcontent.com/e/' + ref, _url);
      if (vHtml) {
        const m = vHtml.match(/https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*/i);
        if (m) return m[0]!!;
      }
    }
    const wurlMatch = html.match(/"poster"\s*:\s*"[^"]+","wurl"\s*:\s*"([^"]+)"/);
    if (wurlMatch) return wurlMatch[1]!.replace(/\\\//g, '/');
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8) return m3u8[0]!!;
    return null;
  }

  private async resolveVoe(html: string, _url: string): Promise<string | null> {
    const mp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
    if (mp4) return mp4[0]!!;
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8) return m3u8[0]!!;
    const evalMatch = html.match(/<script>\s*tm\s*=\s*('(?:\\.|[^'\\])*')/);
    if (evalMatch) {
      try { const s = evalMatch[1]!.slice(1, -1); const m = s.match(/https?:\/\/[^"'\\]+\.(?:m3u8|mp4)[^"'\\]*/); if (m) return m[0]!!; } catch { /* continue */ }
    }
    return null;
  }

  private async resolveVidhide(html: string, _url: string): Promise<string | null> {
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8) return m3u8[0]!!;
    const mp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
    if (mp4) return mp4[0]!!;
    return null;
  }

  private async resolveOkRu(html: string, url: string): Promise<string | null> {
    const jsMatch = html.match(/data-options="([^"]+)"/);
    if (jsMatch) {
      try {
        const opts = JSON.parse(jsMatch[1]!.replace(/&quot;/g, '"'));
        const vLink = opts.flashvars && opts.flashvars.metadataUrl || '';
        if (vLink) {
          const vHtml = await fetchHtml(vLink, 'https://ok.ru/');
          if (vHtml) {
            const js = vHtml.match(/<script>\s*tm\s*=\s*('(?:\\.|[^'\\])*')/);
            if (js) {
              try { const s = js[1]!.slice(1, -1); const m = s.match(/https?:\/\/[^"'\\]+\.(?:m3u8|mp4)[^"'\\]*/); if (m) return m[0]!; } catch { /* continue */ }
            }
            const m3 = vHtml.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
            if (m3) return m3[0];
          }
        }
      } catch { /* continue */ }
    }
    return null;
  }

  private async resolveStreamtape(html: string, url: string): Promise<string | null> {
    const ideoDiv = html.match(/id="ideoolink"[^>]*>([^<]+)<\/div>/);
    if (ideoDiv && ideoDiv[1]!) {
      let path = ideoDiv[1]!.trim();
      if (path.startsWith('/')) path = path.substring(1);
      const fullUrl = 'https://' + path + '&stream=1';
      const vHtml = await fetchHtml(fullUrl, url);
      if (vHtml) {
        const m = vHtml.match(/https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*/i);
        if (m) return m[0]!!;
        const link = vHtml.match(/"link"\s*:\s*"([^"]+)"/);
        if (link) return link[1]!.replace(/\\\//g, '/');
      }
    }
    const botDiv = html.match(/id="botlink"[^>]*>([^<]+)<\/div>/);
    if (botDiv && botDiv[1]!) {
      let botPath = botDiv[1]!.trim();
      if (botPath.startsWith('/')) botPath = botPath.substring(1);
      const botVHtml = await fetchHtml('https://' + botPath, url);
      if (botVHtml) {
        const botVid = botVHtml.match(/https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)[^"'\s<>]*/i);
        if (botVid) return botVid[0];
      }
    }
    return null;
  }

  private async resolveMp4Upload(html: string, _url: string): Promise<string | null> {
    const direct = html.match(/https?:\/\/a\d+\.mp4upload\.com:\d+\/d\/[a-zA-Z0-9/]+\/video\.mp4/i);
    if (direct) return direct[0]!;
    const legacy = html.match(/https?:\/\/a\d+\.mp4upload\.com:\d+\/d\/[a-zA-Z0-9]+/i);
    if (legacy) return legacy[0]!;
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8 && !m3u8[0]!.includes('videojs') && !m3u8[0]!.includes('css') && !m3u8[0]!.includes('.js')) return m3u8[0]!;
    return null;
  }

  private async resolveUpstream(html: string, _url: string): Promise<string | null> {
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8) return m3u8[0]!!;
    const mp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
    if (mp4) return mp4[0]!!;
    return null;
  }

  private async resolveNetuTv(html: string, _url: string): Promise<string | null> {
    const evalMatch = html.match(/eval\s*\(([^)]+)\)/);
    if (evalMatch) {
      try {
        const decoded = Buffer.from(evalMatch[1]!.replace(/['"]/g, ''), 'base64').toString();
        const m = decoded.match(/https?:\/\/[^"'\\]+\.(?:m3u8|mp4)[^"'\\]*/);
        if (m) return m[0]!!;
      } catch { /* continue */ }
    }
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8) return m3u8[0]!!;
    return null;
  }

  private async resolveVidmoly(html: string, _url: string): Promise<string | null> {
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8) return m3u8[0]!!;
    const mp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
    if (mp4) return mp4[0]!!;
    return null;
  }

  private async resolveYourUpload(html: string, _url: string): Promise<string | null> {
    const direct = html.match(/https?:\/\/[^"'\s<>]+\.yourupload\.com\/[^"'\s<>]+\.(?:mp4|m3u8)[^"'\s<>]*/i);
    if (direct) return direct[0]!;
    const fileMatch = html.match(/(?:file|src|source)\s*[:=]\s*["']([^"']+\.(?:mp4|m3u8|mkv|webm)[^"']*)["']/i);
    if (fileMatch && fileMatch[1]!.startsWith('http')) return fileMatch[1]!;
    const mp4 = html.match(/https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i);
    if (mp4 && !mp4[0]!.includes('novideo')) return mp4[0]!;
    const m3u8 = html.match(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i);
    if (m3u8) return m3u8[0]!!;
    return null;
  }

  private async resolveJWPlayer(html: string, referer?: string): Promise<string | null> {
    const scripts: string[] = [];
    const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m[1]!.length > 10) scripts.push(m[1]!);
    }
    for (const script of scripts) {
      if (!script.includes('jwplayer') && !script.includes('sources') && !script.includes('playlist')) continue;

      const fileMatch = script.match(/["']file["']\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/i);
      if (fileMatch) return fileMatch[1]!;

      const setupMatch = script.match(/jwplayer\s*\(\s*["'][^"']*["']\s*\)\s*\.\s*setup\s*\(\s*(\{[\s\S]*?\})\s*\)\s*;/);
      if (setupMatch) {
        try {
          const config = JSON.parse(setupMatch[1]!.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3').replace(/'/g, '"'));
          if (config.sources && Array.isArray(config.sources)) {
            const sorted = config.sources.filter((s: { file?: string; label?: string }) => s.file).sort((a: { label?: string }, b: { label?: string }) => {
              const aLabel = (a.label || '').match(/(\d+)/);
              const bLabel = (b.label || '').match(/(\d+)/);
              return (parseInt((bLabel && bLabel[1]) || '0') || 0) - (parseInt((aLabel && aLabel[1]) || '0') || 0);
            });
            if (sorted.length > 0) return sorted[0].file;
          }
          if (config.playlist && Array.isArray(config.playlist)) {
            for (const item of config.playlist) {
              if (item.sources && Array.isArray(item.sources) && item.sources.length > 0) return item.sources[0].file;
              if (item.file) return item.file;
            }
          }
          if (config.file) return config.file;
        } catch { /* continue */ }
      }
    }
    return null;
  }

  private async resolveGeneric(embedUrl: string, html: string, referer?: string): Promise<string | null> {
    const jwUrl = await this.resolveJWPlayer(html, referer);
    if (jwUrl) return jwUrl.startsWith('//') ? 'https:' + jwUrl : jwUrl;

    const patterns = [
      /https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/i,
      /https?:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/i,
    ];
    for (const p of patterns) {
      const match = html.match(p);
      if (match) return match[0];
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

  private recordAttempt(host: string, success: boolean): void {
    try {
      this.memory.recordAttempt('host:' + host, 'embed', 'resolve', success, success ? 1 : 0, success ? ['embed'] : [], host);
    } catch { /* non-critical */ }
  }
}
