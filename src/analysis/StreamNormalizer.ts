import { SmartAnalyzer } from './SmartAnalyzer';
import type { StreamInfo, StreamQuality, StreamLanguage } from '../types';

const QUALITY_PATTERNS: { label: string; quality: StreamQuality }[] = [
  { label: '4k', quality: '4K' },
  { label: '2160', quality: '4K' },
  { label: 'uhd', quality: '4K' },
  { label: '1080', quality: '1080p' },
  { label: 'full hd', quality: '1080p' },
  { label: 'fhd', quality: '1080p' },
  { label: 'hd 1080', quality: '1080p' },
  { label: '720', quality: '720p' },
  { label: 'hd', quality: 'HD' },
  { label: 'hd ready', quality: '720p' },
  { label: '480', quality: '480p' },
  { label: 'sd', quality: 'SD' },
  { label: '360', quality: '360p' },
  { label: 'cam', quality: 'CAM' },
  { label: 'camrip', quality: 'CAM' },
  { label: 'telesync', quality: 'CAM' },
  { label: 'hdts', quality: 'CAM' },
  { label: 'hd cam', quality: 'CAM' },
];

const LANGUAGE_PATTERNS: { label: string; lang: StreamLanguage; priority: number }[] = [
  { label: 'latino', lang: 'ES', priority: 10 },
  { label: 'espanol', lang: 'ES', priority: 10 },
  { label: 'castellano', lang: 'ES', priority: 10 },
  { label: 'espanol latino', lang: 'ES', priority: 10 },
  { label: 'audio latino', lang: 'ES', priority: 10 },
  { label: 'subtitulado', lang: 'ES', priority: 5 },
  { label: 'sub espanol', lang: 'ES', priority: 5 },
  { label: 'ingles', lang: 'EN', priority: 9 },
  { label: 'english', lang: 'EN', priority: 9 },
  { label: 'japones', lang: 'JA', priority: 8 },
  { label: 'japanese', lang: 'JA', priority: 8 },
  { label: 'coreano', lang: 'KO', priority: 7 },
  { label: 'korean', lang: 'KO', priority: 7 },
  { label: 'portugues', lang: 'PT', priority: 6 },
  { label: 'portuguese', lang: 'PT', priority: 6 },
  { label: 'frances', lang: 'FR', priority: 5 },
  { label: 'french', lang: 'FR', priority: 5 },
  { label: 'chino', lang: 'ZH', priority: 4 },
  { label: 'chinese', lang: 'ZH', priority: 4 },
  { label: 'turco', lang: 'TR', priority: 3 },
  { label: 'turkce', lang: 'TR', priority: 3 },
  { label: 'turkish', lang: 'TR', priority: 3 },
];

export class StreamNormalizer {
  private ai: SmartAnalyzer;
  private spanishBias = true;

  constructor(spanishBias = true) {
    this.ai = new SmartAnalyzer();
    this.spanishBias = spanishBias;
  }

  normalize(url: string, labels: string[] = []): StreamInfo {
    const domain = this.extractDomain(url);
    const serverName = this.ai.inferServerName(domain);
    const quality = this.detectQuality(url, labels);
    const language = this.detectLanguage(url, labels);
    const type = this.detectStreamType(url);
    const priority = this.calculatePriority(quality, language, type, labels);

    return {
      url,
      directUrl: null,
      serverName,
      quality,
      language,
      type,
      labels,
      priority,
    };
  }

  normalizeBatch(urls: string[], commonLabels: string[] = []): StreamInfo[] {
    return urls.map(url => this.normalize(url, commonLabels));
  }

  enrichWithEmbed(url: string, directUrl: string | null, labels: string[] = []): StreamInfo {
    const info = this.normalize(url, labels);
    info.directUrl = directUrl;
    if (directUrl) {
      info.type = this.detectStreamType(directUrl);
      if (info.type === 'embed') info.type = 'mp4';
    }
    return info;
  }

  sortByPriority(streams: StreamInfo[]): StreamInfo[] {
    return [...streams].sort((a, b) => b.priority - a.priority);
  }

  deduplicate(streams: StreamInfo[]): StreamInfo[] {
    const seen = new Set<string>();
    return streams.filter(s => {
      const fingerprint = this.urlFingerprint(s.url) + s.serverName + s.quality;
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
  }

  private detectQuality(url: string, labels: string[]): StreamQuality {
    const combined = [...labels, url].join(' ').toLowerCase();

    for (const pattern of QUALITY_PATTERNS) {
      if (combined.includes(pattern.label)) {
        return pattern.quality;
      }
    }
    return 'unknown';
  }

  private detectLanguage(url: string, labels: string[]): StreamLanguage {
    const combined = [...labels, url].join(' ').toLowerCase();
    let bestMatch: StreamLanguage = 'unknown';
    let bestPriority = 0;

    for (const pattern of LANGUAGE_PATTERNS) {
      if (combined.includes(pattern.label) && pattern.priority > bestPriority) {
        bestMatch = pattern.lang;
        bestPriority = pattern.priority;
      }
    }

    if (bestMatch === 'unknown' && this.spanishBias) {
      return 'ES';
    }

    return bestMatch;
  }

  private detectStreamType(url: string): StreamInfo['type'] {
    if (/\.m3u8(\?|$)/i.test(url)) return 'm3u8';
    if (/\.mp4(\?|$)/i.test(url)) return 'mp4';
    if (/\.mkv(\?|$)/i.test(url)) return 'mkv';
    if (/\.webm(\?|$)/i.test(url)) return 'webm';
    if (/embed|iframe|player|watch|video|stream/i.test(url)) return 'embed';
    if (/magnet:|\.torrent|tracker/i.test(url)) return 'torrent';
    return 'other';
  }

  private calculatePriority(quality: StreamQuality, language: StreamLanguage, type: StreamInfo['type'], labels: string[]): number {
    let score = 50;

    if (quality === '4K') score += 30;
    else if (quality === '1080p') score += 25;
    else if (quality === '720p') score += 15;
    else if (quality === 'HD') score += 10;
    else if (quality === 'CAM') score -= 20;

    if (language === 'ES') score += 20;
    else if (language === 'JA') score += 10;
    else if (language === 'EN') score += 8;

    if (type === 'mp4') score += 15;
    else if (type === 'm3u8') score += 10;
    else if (type === 'embed') score -= 5;
    else if (type === 'torrent') score -= 10;

    const labelText = labels.join(' ').toLowerCase();
    if (/descarg|download/.test(labelText)) score += 5;
    if (/server|servidor/.test(labelText)) score += 3;
    if (/ad|publicidad|anuncio/.test(labelText)) score -= 30;

    return Math.max(0, Math.min(100, score));
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname.toLowerCase(); }
    catch { return ''; }
  }

  private urlFingerprint(url: string): string {
    return url.replace(/[?#].*/, '').replace(/\/$/, '').toLowerCase();
  }
}
