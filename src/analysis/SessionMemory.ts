import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../utils/logger';

// ============================================================
// TIPOS
// ============================================================

export interface PatternRecord {
  selector: string;
  selectorClass: string;
  elementType: string;
  action: string;
  urlsFound: number;
  urlTypes: string[];
  success: boolean;
  domain: string;
  timestamp: number;
}

export interface DomainFingerprint {
  domain: string;
  successfulClasses: Map<string, number>;
  successfulTypes: Map<string, number>;
  failedClasses: Map<string, number>;
  containerUrls: string[];
  avgResponseTime: number;
  visits: number;
  lastVisit: number;
}

export interface AdaptiveScores {
  typeBoosts: Record<string, number>;
  actionBoosts: Record<string, number>;
  classBoosts: Record<string, number>;
  containerDomains: string[];
  topPatterns: PatternRecord[];
  currentFingerprint: {
    domain: string;
    topClasses: string[];
    successRate: number;
  } | null;
  predictions: { elementType: string; estimatedSuccess: number; confidence: number }[];
  totalAttempts: number;
  successCount: number;
  urlChains: Record<string, unknown>;
}

export interface PredictionResult {
  estimatedSuccess: number;  // 0-1
  confidence: number;        // 0-1 (how much data backs this)
  signals: string[];
}

export interface UrlChain {
  fromPattern: string;   // regex o patron de path
  toType: 'episodes' | 'embed' | 'servers' | 'download';
  confidence: number;
  lastSuccess: number;
  sampleFrom: string;
  sampleTo: string;
}

interface PersistedData {
  version: number;
  domains: Record<string, DomainFingerprint>;
  patterns: PatternRecord[];
  containerDomains: string[];
  urlChains: Record<string, UrlChain[]>;
  totalAttempts: number;
  successCount: number;
}

// ============================================================
// PERSISTENT MEMORY
// ============================================================

export class SessionMemory {
  private patterns: PatternRecord[] = [];
  private typeBoosts = new Map<string, { s: number; f: number }>();
  private actionBoosts = new Map<string, { s: number; f: number }>();
  private classBoosts = new Map<string, { s: number; f: number }>();
  private containerDomains = new Set<string>();
  private domainFingerprints = new Map<string, DomainFingerprint>();
  private urlChains: Map<string, UrlChain[]> = new Map();
  private successCount = 0;
  private totalAttempts = 0;
  private lastDomain = '';
  private persistPath: string;

  constructor(persistPath?: string) {
    this.persistPath = persistPath || join(process.cwd(), '.scraper-memory.json');
    this.load();
  }

  // ============================================================
  // PERSISTENCIA
  // ============================================================

  private load(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data: PersistedData = JSON.parse(raw);

      if (data.version < 1) return;

      // Restaurar fingerprints
      for (const [domain, fp] of Object.entries(data.domains)) {
        this.domainFingerprints.set(domain, {
          domain,
          successfulClasses: new Map(Object.entries(fp.successfulClasses)),
          successfulTypes: new Map(Object.entries(fp.successfulTypes)),
          failedClasses: new Map(Object.entries(fp.failedClasses)),
          containerUrls: fp.containerUrls,
          avgResponseTime: fp.avgResponseTime,
          visits: fp.visits,
          lastVisit: fp.lastVisit,
        });
      }

      // Restaurar conteos bayesianos desde fingerprints
      for (const [, fp] of this.domainFingerprints) {
        for (const [cls, count] of fp.successfulClasses) {
          const stats = this.classBoosts.get(cls) || { s: 0, f: 0 };
          stats.s += count;
          this.classBoosts.set(cls, stats);
        }
        for (const [cls, count] of fp.failedClasses) {
          const stats = this.classBoosts.get(cls) || { s: 0, f: 0 };
          stats.f += count;
          this.classBoosts.set(cls, stats);
        }
        for (const [type, count] of fp.successfulTypes) {
          const stats = this.typeBoosts.get(type) || { s: 0, f: 0 };
          stats.s += count;
          this.typeBoosts.set(type, stats);
        }
      }

      // Restaurar container domains
      for (const d of data.containerDomains) { this.containerDomains.add(d); }

      // Restaurar cadenas de URL (v2)
      if (data.version >= 2 && data.urlChains) {
        for (const [key, chains] of Object.entries(data.urlChains)) {
          this.urlChains.set(key, chains);
        }
      }


      this.patterns = data.patterns.slice(-100); // ultimos 100
      this.totalAttempts = data.totalAttempts;
      this.successCount = data.successCount;

      getLogger().debug({ path: this.persistPath, domains: this.domainFingerprints.size }, 'Memory loaded from disk');
    } catch (err) {
      getLogger().debug({ error: (err as Error).message }, 'Memory load failed, starting fresh');
    }
  }

  private save(): void {
    try {
      const domains: Record<string, any> = {};
      for (const [domain, fp] of this.domainFingerprints) {
        domains[domain] = {
          domain: fp.domain,
          successfulClasses: Object.fromEntries([...fp.successfulClasses]),
          successfulTypes: Object.fromEntries([...fp.successfulTypes]),
          failedClasses: Object.fromEntries([...fp.failedClasses]),
          containerUrls: fp.containerUrls,
          avgResponseTime: fp.avgResponseTime,
          visits: fp.visits,
          lastVisit: fp.lastVisit,
        };
      }

      const urlChains: Record<string, UrlChain[]> = {};
      for (const [key, chains] of this.urlChains) {
        urlChains[key] = chains;
      }

      const data: PersistedData = {
        version: 2,
        domains,
        patterns: this.patterns.slice(-200),
        containerDomains: [...this.containerDomains],
        urlChains,
        totalAttempts: this.totalAttempts,
        successCount: this.successCount,
      };

      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      getLogger().debug({ error: (err as Error).message }, 'Memory save failed');
    }
  }

  // ============================================================
  // REGISTRO DE INTENTOS
  // ============================================================

  recordAttempt(
    selector: string,
    elementType: string,
    action: string,
    success: boolean,
    urlsFound: number,
    urlTypes: string[],
    domain?: string,
  ): void {
    this.totalAttempts++;
    const cls = this.extractClass(selector);
    const dom = domain || this.lastDomain;

    const record: PatternRecord = {
      selector, selectorClass: cls, elementType, action,
      urlsFound, urlTypes, success, domain: dom,
      timestamp: Date.now(),
    };
    this.patterns.push(record);

    // Actualizar conteos bayesianos
    const tKey = elementType;
    const aKey = action;

    if (!this.typeBoosts.has(tKey)) this.typeBoosts.set(tKey, { s: 0, f: 0 });
    if (!this.actionBoosts.has(aKey)) this.actionBoosts.set(aKey, { s: 0, f: 0 });

    if (cls) {
      if (!this.classBoosts.has(cls)) this.classBoosts.set(cls, { s: 0, f: 0 });
      // Tambien registrar clases generalizadas
      for (const gCls of this.generalizeClass(cls)) {
        if (!this.classBoosts.has(gCls)) this.classBoosts.set(gCls, { s: 0, f: 0 });
      }
    }

    if (success && urlsFound > 0) {
      this.successCount++;
      this.typeBoosts.get(tKey)!.s += urlsFound;
      this.actionBoosts.get(aKey)!.s += 1;
      if (cls) {
        this.classBoosts.get(cls)!.s += urlsFound;
        for (const gCls of this.generalizeClass(cls)) {
          this.classBoosts.get(gCls)!.s += urlsFound * 0.5; // media fuerza para generalizados
        }
      }
      this.updateDomainFingerprint(dom, cls, elementType, true, urlsFound, urlTypes);

    } else {
      this.typeBoosts.get(tKey)!.f += 1;
      this.actionBoosts.get(aKey)!.f += 1;
      if (cls) {
        this.classBoosts.get(cls)!.f += 1;
        for (const gCls of this.generalizeClass(cls)) {
          this.classBoosts.get(gCls)!.f += 1;
        }
      }
      this.updateDomainFingerprint(dom, cls, elementType, false, 0, []);
    }

    // Auto-save cada 10 intentos
    if (this.totalAttempts % 10 === 0) {
      this.save();
    }
  }

  // ============================================================
  // SCORING BAYESIANO
  // ============================================================

  getTypeBoost(elementType: string): number {
    const stats = this.typeBoosts.get(elementType);
    if (!stats) return 0;
    const est = this.bayesianEstimate(stats.s, stats.f);
    return Math.round(Math.min(est.mean * 25, 25));
  }

  getActionBoost(action: string): number {
    const stats = this.actionBoosts.get(action);
    if (!stats) return 0;
    const est = this.bayesianEstimate(stats.s, stats.f);
    return Math.round(Math.min(est.mean * 15, 15));
  }

  getClassBoost(cls: string): number {
    const stats = this.classBoosts.get(cls);
    if (!stats) return 0;
    const est = this.bayesianEstimate(stats.s, stats.f);
    return Math.round(Math.min(est.mean * 20, 20));
  }

  // ============================================================
  // PREDICCION (nuevo)
  // ============================================================

  predictSuccess(elementType: string, elementClass: string, domain?: string): PredictionResult {
    const signals: string[] = [];
    let totalScore = 0;
    let totalWeight = 0;

    // Señal 1: Tipo de elemento histórico
    const typeBoost = this.getTypeBoost(elementType);
    if (typeBoost > 0) {
      totalScore += typeBoost / 25;
      totalWeight += 1;
      signals.push(`type:${elementType}=${typeBoost}/25`);
    }

    // Señal 2: Clase CSS
    if (elementClass) {
      const classBoost = this.getClassBoost(elementClass);
      if (classBoost > 0) {
        totalScore += classBoost / 20;
        totalWeight += 1.5;
        signals.push(`class:${elementClass}=${classBoost}/20`);
      }
    }

    // Señal 3: Fingerprint del dominio actual
    if (domain && this.domainFingerprints.has(domain)) {
      const fp = this.domainFingerprints.get(domain)!;
      let domSuccesses = 0;
      let domTotal = 0;
      for (const [, v] of fp.successfulClasses) { domSuccesses += v; domTotal += v; }
      for (const [, v] of fp.failedClasses) { domTotal += v; }
      if (domTotal > 0) {
        const domRate = domSuccesses / domTotal;
        totalScore += domRate;
        totalWeight += 0.5;
        signals.push(`domain:${domain}=${Math.round(domRate * 100)}%`);
      }
    }

    // Señal 4: Patrones generalizados de la clase
    if (elementClass) {
      for (const gCls of this.generalizeClass(elementClass)) {
        const gBoost = this.getClassBoost(gCls);
        if (gBoost > 5) {
          totalScore += gBoost / 40; // peso reducido para generalizaciones
          totalWeight += 0.3;
          signals.push(`gen:${gCls}=${gBoost}/20`);
        }
      }
    }

    const estimatedSuccess = totalWeight > 0 ? Math.min(1, totalScore / totalWeight) : 0.5;
    const confidence = Math.min(1, totalWeight / 3);

    return { estimatedSuccess, confidence, signals };
  }

  getPredictions(): AdaptiveScores['predictions'] {
    const elementTypes = [...new Set(this.patterns.map(p => p.elementType))];
    return elementTypes.map(type => {
      const pred = this.predictSuccess(type, '', this.lastDomain);
      return { elementType: type, estimatedSuccess: pred.estimatedSuccess, confidence: pred.confidence };
    }).sort((a, b) => b.estimatedSuccess - a.estimatedSuccess);
  }

  // ============================================================
  // CONTAINER DOMAINS
  // ============================================================

  isKnownContainerDomain(domain: string): boolean {
    if (this.containerDomains.has(domain)) return true;
    const fp = this.domainFingerprints.get(domain);
    return fp ? fp.containerUrls.length > 0 : false;
  }

  addContainerDomain(domain: string): void {
    if (!this.containerDomains.has(domain)) {
      this.containerDomains.add(domain);
      this.save();
    }
  }

  // ============================================================
  // URL CHAIN LEARNING (nuevo)
  // ============================================================

  recordChain(fromUrl: string, toUrl: string, resultType: 'episodes' | 'embed' | 'servers' | 'download'): void {
    const fromDomain = this.extractDomain(fromUrl);
    const fromPattern = this.extractPathPattern(fromUrl);

    if (!fromPattern || fromPattern.length < 3) return;

    const chainKey = fromDomain + '|' + fromPattern;
    if (!this.urlChains.has(chainKey)) {
      this.urlChains.set(chainKey, []);
    }

    const chains = this.urlChains.get(chainKey)!;
    const existing = chains.find(c => c.toType === resultType);

    if (existing) {
      existing.confidence = Math.min(100, existing.confidence + 20);
      existing.lastSuccess = Date.now();
    } else {
      chains.push({
        fromPattern,
        toType: resultType,
        confidence: 60,
        lastSuccess: Date.now(),
        sampleFrom: fromUrl.slice(0, 80),
        sampleTo: toUrl.slice(0, 80),
      });
    }

    this.save();
    getLogger().debug({ from: fromPattern, to: resultType }, 'URL chain recorded');
  }

  getChainsForDomain(domain: string): UrlChain[] {
    const results: UrlChain[] = [];
    for (const [key, chains] of this.urlChains) {
      if (key.startsWith(domain + '|')) {
        results.push(...chains);
      }
    }
    return results.sort((a, b) => b.confidence - a.confidence);
  }

  private extractDomain(url: string): string {
    try { return new URL(url).hostname.replace('www.', ''); }
    catch { return url.slice(0, 40); }
  }

  private extractPathPattern(url: string): string {
    try {
      const path = new URL(url).pathname;
      // Normalizar: /anime/naruto/ -> /anime/{slug}/
      // /episode/naruto-1x220/ -> /episode/{slug}-{num}/
      let pattern = path.replace(/\/[^/]+\/\d+$/, '/{num}');
      pattern = pattern.replace(/\d+x\d+/, '{ep}');
      // Reemplazar el ultimo segmento de texto con {slug}
      const parts = pattern.split('/').filter(Boolean);
      if (parts.length >= 1) {
        const last = parts[parts.length - 1]!;
        if (!last.includes('{') && !/^\d+$/.test(last)) {
          parts[parts.length - 1] = '{slug}';
        }
      }
      return '/' + parts.join('/') + '/';
    } catch {
      return '';
    }
  }

  // ============================================================
  // DOMINIO ACTUAL
  // ============================================================

  setCurrentDomain(domain: string): void {
    this.lastDomain = domain;
    if (this.domainFingerprints.has(domain)) {
      this.domainFingerprints.get(domain)!.lastVisit = Date.now();
    }
  }

  getDomainFingerprint(domain: string): DomainFingerprint | undefined {
    return this.domainFingerprints.get(domain);
  }

  getCurrentDomainSuccessRate(): number {
    const fp = this.domainFingerprints.get(this.lastDomain);
    if (!fp) return 1;
    let s = 0, f = 0;
    for (const [, v] of fp.successfulClasses) s += v;
    for (const [, v] of fp.failedClasses) f += v;
    if (s + f === 0) return 1;
    return s / (s + f);
  }

  getSuccessRate(): number {
    if (this.totalAttempts === 0) return 1;
    return this.successCount / this.totalAttempts;
  }

  // ============================================================
  // PATRONES
  // ============================================================

  getTopPatterns(limit = 5): PatternRecord[] {
    return this.patterns
      .filter(p => p.success && p.urlsFound > 0)
      .sort((a, b) => b.urlsFound - a.urlsFound)
      .slice(0, limit);
  }

  getTopClassesForDomain(domain: string, limit = 5): string[] {
    const fp = this.domainFingerprints.get(domain);
    if (!fp) return [];
    return Object.entries(fp.successfulClasses)
      .sort((a, b) => b[1]! - a[1]!)
      .slice(0, limit)
      .map(([k]) => k);
  }

  getBestClass(): string | null {
    let best = '';
    let bestScore = 0;
    for (const [cls, stats] of this.classBoosts) {
      const est = this.bayesianEstimate(stats.s, stats.f);
      if (est.mean > bestScore && est.confidence > 1) {
        bestScore = est.mean;
        best = cls;
      }
    }
    return best || null;
  }

  // ============================================================
  // REPORTE
  // ============================================================

  getAdaptiveScores(): AdaptiveScores {
    const classBoosts: Record<string, number> = {};
    for (const [cls] of this.classBoosts) {
      classBoosts[cls] = this.getClassBoost(cls);
    }

    let currentFingerprint: AdaptiveScores['currentFingerprint'] = null;
    if (this.lastDomain) {
      const fp = this.domainFingerprints.get(this.lastDomain);
      if (fp) {
        currentFingerprint = {
          domain: this.lastDomain,
          topClasses: Object.entries(fp.successfulClasses)
            .sort((a, b) => b[1]! - a[1]!)
            .slice(0, 5)
            .map(([k]) => k),
          successRate: this.getCurrentDomainSuccessRate(),
        };
      }
    }

    return {
      typeBoosts: Object.fromEntries(
        [...this.typeBoosts.keys()].map(k => [k, this.getTypeBoost(k)]),
      ),
      actionBoosts: Object.fromEntries(
        [...this.actionBoosts.keys()].map(k => [k, this.getActionBoost(k)]),
      ),
      classBoosts,
      containerDomains: [...this.containerDomains],
      topPatterns: this.getTopPatterns(),
      currentFingerprint,
      predictions: this.getPredictions(),
      totalAttempts: this.totalAttempts,
      successCount: this.successCount,
      urlChains: Object.fromEntries(this.urlChains),
    };
  }

  // ============================================================
  // MANTENIMIENTO
  // ============================================================

  clear(): void {
    this.patterns = [];
    this.typeBoosts.clear();
    this.actionBoosts.clear();
    this.classBoosts.clear();
    this.containerDomains.clear();
    this.domainFingerprints.clear();
    this.successCount = 0;
    this.totalAttempts = 0;
    this.lastDomain = '';
    this.save();
  }

  forceSave(): void {
    this.save();
  }

  // ============================================================
  // INTERNO
  // ============================================================

  private bayesianEstimate(successes: number, failures: number) {
    const alpha = successes + 1;
    const beta = failures + 1;
    const total = alpha + beta;
    return {
      alpha, beta,
      mean: alpha / total,
      confidence: Math.min(total / 10, 1),
    };
  }

  private extractClass(selector: string): string {
    const classMatch = selector.match(/\.([a-zA-Z_][\w-]*)/);
    if (classMatch) return classMatch[1]!;
    const idMatch = selector.match(/#([a-zA-Z_][\w-]*)/);
    if (idMatch) return idMatch[1]!;
    const childMatch = selector.match(/>\s*(\w+)/);
    if (childMatch) return childMatch[1]!;
    return '';
  }

  private generalizeClass(cls: string): string[] {
    const result: string[] = [];
    const lower = cls.toLowerCase();

    // Patrones: logo-list → *-list, server-btn → server-*
    if (lower.includes('-')) {
      const parts = lower.split('-');
      if (parts.length === 2) {
        result.push(`*-${parts[1]!}`);          // logo-list → *-list
        result.push(`${parts[0]!}-*`);          // logo-list → logo-*
      }
    }

    // Palabras clave en la clase
    const keywordPatterns: Record<string, RegExp> = {
      '*-server*': /server|servidor/i,
      '*-player*': /player|reproductor/i,
      '*-list*': /list|lista/i,
      '*-btn*': /btn|button|boton/i,
      '*-card*': /card|tarjeta|item/i,
      '*-tab*': /tab|pestaña/i,
      '*-lang*': /idioma|language|lang/i,
      '*-download*': /download|descarg/i,
    };

    for (const [pattern, regex] of Object.entries(keywordPatterns)) {
      if (regex.test(lower) && !result.includes(pattern)) {
        result.push(pattern);
      }
    }

    return result;
  }

  private updateDomainFingerprint(
    domain: string,
    cls: string,
    elementType: string,
    success: boolean,
    urlsFound: number,
    urlTypes: string[],
  ): void {
    if (!domain) return;

    if (!this.domainFingerprints.has(domain)) {
      this.domainFingerprints.set(domain, {
        domain,
        successfulClasses: new Map(),
        successfulTypes: new Map(),
        failedClasses: new Map(),
        containerUrls: [],
        avgResponseTime: 0,
        visits: 0,
        lastVisit: Date.now(),
      });
    }

    const fp = this.domainFingerprints.get(domain)!;
    fp.visits++;
    fp.lastVisit = Date.now();

    if (success && urlsFound > 0) {
      if (cls) {
        fp.successfulClasses.set(cls, (fp.successfulClasses.get(cls) || 0) + urlsFound);
      }
      fp.successfulTypes.set(elementType, (fp.successfulTypes.get(elementType) || 0) + urlsFound);

      for (const ut of urlTypes) {
        if (ut.startsWith('http')) {
          try {
            const dom = new URL(ut).hostname.replace('www.', '');
            if (!fp.containerUrls.includes(dom)) {
              fp.containerUrls.push(dom);
            }
            this.containerDomains.add(dom);
          } catch { /* ignore */ }
        } else if (ut === 'embed' || ut === 'download') {
          if (!fp.containerUrls.includes(domain)) {
            fp.containerUrls.push(domain);
          }
          this.containerDomains.add(domain);
        }
      }
    } else {
      if (cls) {
        fp.failedClasses.set(cls, (fp.failedClasses.get(cls) || 0) + 1);
      }
    }
  }
}

// ============================================================
// TEXT SIMILARITY
// ============================================================

export function textSimilarity(query: string, candidate: string): number {
  const qTokens = tokenize(query);
  const cTokens = tokenize(candidate);
  if (qTokens.length === 0 || cTokens.length === 0) return 0;

  const qSet = new Set(qTokens);
  const cSet = new Set(cTokens);
  const intersection = new Set([...qSet].filter(t => cSet.has(t)));
  const union = new Set([...qSet, ...cSet]);

  const jaccard = intersection.size / union.size;
  const dice = (2 * intersection.size) / (qSet.size + cSet.size);

  // Word-level Jaccard bonus for multi-word queries
  let wordJaccard = 0;
  if (qTokens.length > 1 && cTokens.length > 1) {
    let commonWords = 0;
    for (const t of qTokens) {
      if (cTokens.includes(t)) commonWords++;
    }
    wordJaccard = commonWords / (qTokens.length + cTokens.length - commonWords);
  }

  // Levenshtein for fuzzy matching on short strings
  let levScore = 0;
  const qClean = query.toLowerCase().replace(/[^a-záéíóúñ0-9]/gi, '');
  const cClean = candidate.toLowerCase().replace(/[^a-záéíóúñ0-9]/gi, '');
  if (qClean.length > 2 && cClean.length > 2) {
    const dist = levenshtein(qClean, cClean);
    const maxLen = Math.max(qClean.length, cClean.length);
    levScore = 1 - dist / maxLen;
  }

  return Math.round((dice * 0.35 + jaccard * 0.15 + levScore * 0.35 + wordJaccard * 0.15) * 100) / 100;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1]
        ? dp[i - 1]![j - 1]!
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-záéíóúñ0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

// ============================================================
// SINGLETON
// ============================================================

let defaultMemory: SessionMemory | null = null;

export function getSessionMemory(): SessionMemory {
  if (!defaultMemory) {
    defaultMemory = new SessionMemory();
  }
  return defaultMemory;
}

export function resetSessionMemory(): void {
  defaultMemory?.forceSave();
  defaultMemory?.clear();
  defaultMemory = null;
}



