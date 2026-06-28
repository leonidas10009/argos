import type { Page } from 'puppeteer';
import { getLogger } from '../utils/logger';
import { SmartAnalyzer } from './SmartAnalyzer';
import { DebugViewer } from './DebugViewer';
import { SessionMemory, textSimilarity } from './SessionMemory';
import { DynamicPageHandler } from './DynamicPageHandler';
import { PageTypeClassifier } from './PageTypeClassifier';
import { SkeletonDetector } from './SkeletonDetector';
import { StreamNormalizer } from './StreamNormalizer';
import type { RawElement } from './types';
import type { StreamInfo } from '../types';

interface PageModel {
  title: string;
  elements: RawElement[];
  semanticTree: SemanticNode[];
}

interface SemanticNode {
  role: string;
  selector: string;
  label: string;
  confidence: number;
  children: SemanticNode[];
  actions: string[];
  extractedUrls: string[];
}

interface ActionResult {
  action: string;
  target: string;
  success: boolean;
  changes: number;
  newUrls: string[];
  newState?: PageModel;
}

interface ExplorationStep {
  step: number;
  action: string;
  target: string;
  reasoning: string;
  result: ActionResult;
}

export interface ServerCatalog {
  name: string;
  domain: string;
  urls: { url: string; type: string; label: string; directUrl?: string | null; quality?: string; language?: string }[];
}

export interface SmartScrapeResult {
  url: string;
  title: string;
  steps: ExplorationStep[];
  serverCatalog: ServerCatalog[];
  streams: StreamInfo[];
  findings: {
    videoUrls: string[];
    downloadUrls: string[];
    serverUrls: string[];
    navigationUrls: string[];
    otherUrls: string[];
  };
  model: { roles: string[]; totalElements: number; interactions: number };
  durationMs: number;
  partial: boolean;
}

export type ContentGoal = 'video' | 'image' | 'download' | 'manga' | 'document' | 'auto';

export interface AutonomousScraperOptions {
  maxRequests?: number;
  searchTerm?: string;
  searchTerms?: string[];
  contentGoal?: ContentGoal;
  debug?: boolean;
  debugDir?: string;
  deadlineMs?: number;
}

export class AutonomousScraper {
  private page: Page;
  private visited = new Set<string>();
  private urlCollector: { url: string; category: string; source: string }[] = [];
  private steps: ExplorationStep[] = [];
  private stepCount = 0;
  private requestCount = 0;
  private maxRequests = 50;
  private searchTerm = '';
  private searchTerms: string[] = [];
  private contentGoal: ContentGoal = 'auto';
  private deadlineMs = 90_000;
  private streamNormalizer: StreamNormalizer;
  private ai: SmartAnalyzer;
  private memory: SessionMemory;
  private dynamic: DynamicPageHandler;
  private debug: DebugViewer | null = null;
  private consecutiveFails = 0;
  private seenGroupPatterns = new Set<string>();
  private skipClasses = new Set<string>();
  private lastModelUrl = '';
  private cachedModel: PageModel | null = null;
  private pageClassifier = new PageTypeClassifier();
  private skeletonDetector = new SkeletonDetector();

  constructor(page: Page, options?: AutonomousScraperOptions) {
    this.page = page;
    if (options?.maxRequests) this.maxRequests = options.maxRequests;
    if (options?.searchTerm) this.searchTerm = options.searchTerm;
    if (options?.searchTerms) this.searchTerms = options.searchTerms;
    if (options?.contentGoal) this.contentGoal = options.contentGoal;
    if (options?.deadlineMs) this.deadlineMs = options.deadlineMs;
    this.ai = new SmartAnalyzer();
    this.memory = new SessionMemory();
    this.dynamic = new DynamicPageHandler(page);
    this.streamNormalizer = new StreamNormalizer();
    if (options?.debug) {
      this.debug = new DebugViewer(options.debugDir || './debug');
    }
  }

  private async throttle(): Promise<boolean> {
    this.requestCount++;
    if (this.requestCount > this.maxRequests) {
      getLogger().warn({ max: this.maxRequests }, 'Request limit reached, stopping exploration');
      return false;
    }
    const delay = 400 + Math.random() * 800;
    await new Promise(r => setTimeout(r, delay));
    return true;
  }

  private static AD_DOMAINS = /analytics|track|pixel|beacon|adexchange|cookielaw|cookiepedia|onetrust|doubleclick|googlesyndication|googletagmanager/i;

  async investigate(url: string): Promise<SmartScrapeResult> {
    const log = getLogger();
    const start = Date.now();
    const MAX_TIME = this.deadlineMs;
    const MAX_DEPTH = 3;
    this.urlCollector = [];
    this.steps = [];
    this.stepCount = 0;
    this.consecutiveFails = 0;
    this.seenGroupPatterns.clear();
    // CARGAR skip classes desde memoria persistente (no borrar)
    this.skipClasses.clear();
    for (const domain of [this.extractDomain(url)]) {
      const fp = this.memory.getDomainFingerprint(domain);
      if (fp) {
        for (const [cls, fails] of fp.failedClasses) {
          const succs = fp.successfulClasses.get(cls) || 0;
          if (fails >= 3 && succs === 0) {
            this.skipClasses.add(cls);
          }
        }
      }
    }
    this.cachedModel = null;
    this.lastModelUrl = '';

    log.info({ skipClasses: this.skipClasses.size }, 'Loaded skip classes from memory');

    const knownUrls = new Set<string>();
    const visitedPages = new Set<string>();
    let pageUrlsLocal: string[] = [];

    const diffAndCollect = (urls: string[], source: string, domain: string) => {
      const fresh = urls.filter(u => u && u !== 'about:blank' && !knownUrls.has(u) && !AutonomousScraper.AD_DOMAINS.test(u) && !AutonomousScraper.AD_DOMAINS.test(this.extractDomain(u)));
      for (const u of fresh) {
        knownUrls.add(u);
        pageUrlsLocal.push(u);
        this.urlCollector.push({ url: u, category: 'unknown', source: source + ' | ' + domain });
      }
      return fresh;
    };

    const explorePage = async (pageUrl: string, searchTerm?: string, depth = 0): Promise<void> => {
      if (Date.now() - start > MAX_TIME) return;
      // Si ya encontramos servers a profundidad baja, no seguir
      const serverCount = this.urlCollector.filter(u => {
        const c = this.ai.classifyURL(u.url, u.source);
        return c.type === 'embed' || c.type === 'direct-video' || c.type === 'stream';
      }).length;
      const effectiveMaxDepth = serverCount >= 3 ? Math.min(MAX_DEPTH, depth + 1) : MAX_DEPTH;
      if (depth > effectiveMaxDepth) return;
      // Fingerprint agresivo: quitar todos los query params, solo path
      let fp = pageUrl.split('?')[0].replace(/\/+$/, '');
      // Normalizar IDs numericos en la URL
      fp = fp.replace(/\/\d+$/, '/X');
      if (visitedPages.has(fp)) return;
      visitedPages.add(fp);
      log.debug({ url: pageUrl, depth }, 'Exploring');

      // Scope local de URLs para esta pagina
      pageUrlsLocal = [];

      await this.dynamic.navigate(pageUrl, { timeout: 15000 });
      await this.dynamic.triggerLazyElements();
      const domain = this.extractDomain(pageUrl);
      this.memory.setCurrentDomain(domain);

      const model = await this.buildModel();

      // Si esta pagina es casi todo esqueleto (ya visitada), solo extraer URLs
      const skeletonSelectors = (this.skeletonDetector as any).skeletonSelectors?.get(domain);
      if (skeletonSelectors && skeletonSelectors.size > 10 && depth > 0) {
        const totalEls = model.elements.length;
        const skeletonEls = model.elements.filter(e => this.skeletonDetector.isSkeleton(domain, e.selector, e.text)).length;
        if (totalEls > 0 && skeletonEls / totalEls > 0.7) {
          log.debug({ url: pageUrl, skelPct: Math.round(skeletonEls / totalEls * 100) }, 'Mostly skeleton, scan-only');
          const quickUrls = await this.extractAllUrls();
          diffAndCollect(quickUrls, 'skeleton-scan', pageUrl);
          return;
        }
      }

      const pageUrls = await this.extractAllUrls();

      // Alimentar detector de esqueleto (cross-page dedup)
      this.skeletonDetector.addPageFingerprint(
        domain, pageUrl,
        model.elements.map(e => e.selector),
        model.elements.map(e => e.text),
        model.elements.map(e => e.class),
      );

      // Consultar cadenas conocidas: si esta URL ya sabemos que lleva a servers
      const knownChains = this.memory.getChainsForDomain(domain);
      if (knownChains.length > 0 && depth === 1) {
        log.info({ chains: knownChains.length }, 'Known URL chains available for this domain');
      }

      // Clasificar tipo de pagina para adaptar estrategia
      const pageAnalysis = this.pageClassifier.analyze(model.elements, pageUrl, model.title);
      log.info({ type: pageAnalysis.type, conf: pageAnalysis.confidence, signals: pageAnalysis.signals.slice(0, 3).join(', ') }, 'Page classified');

      // === ESTRATEGIA POR TIPO DE PAGINA ===
      if ((pageAnalysis.type as string) === 'content') {
        // Pagina de contenido: buscar servers con network interception
        const contentGroups = this.detectGroups(model.elements);
        for (const cg of contentGroups) {
          const isServer = /server|servidor|opcion|download|descarg|video|player|reproduct/i.test(cg.label + cg.labels.join(' '));
          if (!isServer) continue;
          await this.logStep('content-servers', cg.label, `Servers: ${cg.labels.slice(0, 5).join(', ')}`);
          for (const item of cg.items.slice(0, 6)) {
            if (Date.now() - start > MAX_TIME) break;
            const captured = await this.dynamic.clickAndCaptureUrls(item.selector, 5000);
            diffAndCollect(captured, item.label, domain);
            this.memory.recordAttempt(item.selector, 'clickable', 'click', captured.length > 0, captured.length, captured, domain);
          }
        }
        // En pagina de contenido, buscar iframes y videos ya cargados
        const finalContentUrls = await this.extractAllUrls();
        diffAndCollect(finalContentUrls, 'content-final', pageUrl);
        return; // No seguir explorando menus en pagina de contenido
      }

      // Progressive search: try searchTerms array, fall back through list
      const effectiveSearchTerms: string[] = searchTerm
        ? [searchTerm, ...this.searchTerms.filter(t => t !== searchTerm)]
        : this.searchTerms.length > 0
          ? this.searchTerms
          : [];

      if (effectiveSearchTerms.length > 0 && depth === 0) {
        let searchSucceeded = false;

        for (const st of effectiveSearchTerms) {
          if (Date.now() - start > MAX_TIME) break;
          if (searchSucceeded) break;

          log.debug({ searchTerm: st }, 'Progressive search attempt');

          if (pageUrls.length > 5) {
            const inferred = this.ai.inferCandidateUrls(pageUrls, st, pageUrl);
            if (inferred.length > 0) {
              log.info({ candidates: inferred.length, term: st }, 'URL inferred from page patterns');
              for (const candidateUrl of inferred.slice(0, 1)) {
                if (visitedPages.has(candidateUrl)) continue;
                await this.logStep('infer', candidateUrl, `Inferido: ${candidateUrl.slice(0, 50)}`);
                try {
                  await explorePage(candidateUrl, undefined, depth + 1);
                  visitedPages.add(candidateUrl.split('?')[0].replace(/\/\d+$/, '/X'));
                  await this.dynamic.navigate(pageUrl, { timeout: 10000 });
                  await this.buildModel();
                  searchSucceeded = true;
                } catch { continue; }
              }
            }
          }

          if (searchSucceeded) break;

          const searchInput = model.elements.find(e =>
            e.type === 'input' && /search|buscar|busqueda|find|filt/i.test((e.attr.placeholder || '') + (e.id || '') + (e.class || ''))
          );
          if (searchInput) {
            await this.logStep('search', searchInput.selector, `Buscando: "${st}"`);
            await this.safeType(searchInput.selector, st);
            const searchModel = await this.buildModel();
            const results = this.scoreResults(searchModel.elements, st);
            if (results.length > 0) {
              log.info({ found: results.length, term: st }, 'Search results, exploring depth-first');
              for (const r of results.slice(0, 2)) {
                if (Date.now() - start > MAX_TIME) break;
                const href = r.element.attr.href;
                if (!href || visitedPages.has(href)) continue;
                await this.logStep('navigate', r.element.selector, `Siguiendo: "${r.element.text.slice(0, 50)}"`);
                try {
                  await explorePage(href, undefined, depth + 1);
                  await this.dynamic.navigate(pageUrl, { timeout: 10000 });
                  await this.buildModel();
                  searchSucceeded = true;
                } catch (err) {
                  log.debug({ error: (err as Error).message }, 'Navigate failed');
                  try { await this.dynamic.navigate(pageUrl, { timeout: 10000 }); } catch { return; }
                }
              }

              const bestSim = results[0]?.sim || 0;
              if (results.length === 0 || bestSim < 0.3) {
                const candidateUrls = this.ai.inferCandidateUrls(pageUrls, st, pageUrl);
                if (candidateUrls.length > 0) {
                  log.info({ candidates: candidateUrls.length, bestSim, term: st }, 'Trying inferred URLs (low similarity)');
                  for (const candidateUrl of candidateUrls.slice(0, 2)) {
                    if (Date.now() - start > MAX_TIME) break;
                    if (visitedPages.has(candidateUrl)) continue;
                    await this.logStep('infer', candidateUrl, `Inferido: ${candidateUrl.slice(0, 50)}`);
                    try {
                      await explorePage(candidateUrl, undefined, depth + 1);
                      visitedPages.add(candidateUrl.split('?')[0].replace(/\/\d+$/, '/X'));
                      await this.dynamic.navigate(pageUrl, { timeout: 10000 });
                      await this.buildModel();
                      searchSucceeded = true;
                    } catch { continue; }
                  }
                }
              }
            }
          }
        }
        // Merge searchTerm state for the rest of explore
        searchTerm = searchSucceeded ? effectiveSearchTerms[0] : undefined;
      }

      const currentModel = await this.buildModel();
      const groups = this.detectGroups(currentModel.elements);
      let groupFails = 0;

      for (const group of groups) {
        if (Date.now() - start > MAX_TIME) break;
        if (groupFails >= 2) break;

        // Saltar menus de navegacion (son iguales en todas las paginas)
        const isNavMenu = /nav|menu|header|footer/i.test(group.label + group.selector);
        if (isNavMenu) continue;

        if (this.shouldSkipElement(group.selector, 'group', group.labels.join(','))) continue;

        await this.logStep('group', group.selector, `Grupo: ${group.labels.slice(0, 5).join(', ')}`);
        const isServerGroup = /server|servidor|opcion|mirror|source|video|player|netu|yourupload|mega|okru|streamtape|filemoon|uqload|hqq|swhoi|burstcloud|streamwish|embedwish|nyuu|fembed|cloudvideo|logo|download|descarg|idioma|language/i.test(group.label + group.labels.join(' '));
        let groupHadSuccess = false;

        for (const item of group.items.slice(0, isServerGroup ? (pageAnalysis.type === 'content' ? 6 : 4) : (pageAnalysis.type === 'content' ? 0 : 2))) {
          if (Date.now() - start > MAX_TIME) break;
          if (visitedPages.has(item.selector)) continue;
          visitedPages.add(item.selector);
          if (this.shouldSkipElement(item.selector, 'click', item.label)) continue;

          const href = item.attr?.href;
          if (href && !isServerGroup && (href.startsWith('http') || href.startsWith('/')) && !href.startsWith('#') && !href.startsWith('javascript:')) {
            await this.logStep('navigate', item.selector, `Siguiendo: "${item.label}"`);
            try {
              await explorePage(href, undefined, depth + 1);
              // Marcar como visitado para no redescubrir
              visitedPages.add(href.split('?')[0].replace(/\/\d+$/, '/X'));
              await this.dynamic.navigate(pageUrl, { timeout: 10000 });
              await this.buildModel();
              groupHadSuccess = true;
            } catch { continue; }
            continue;
          }

          if (isServerGroup) {
            const captured = await this.dynamic.clickAndCaptureUrls(item.selector, 4000);
            const fresh = diffAndCollect(captured, item.label, domain);
            this.memory.recordAttempt(item.selector, 'clickable', 'click', fresh.length > 0, fresh.length, fresh, domain);
            if (fresh.length > 0) groupHadSuccess = true;
          } else {
            await this.safeClickGroup(item.selector);
            const after = await this.extractAllUrls();
            const fresh = diffAndCollect(after, item.label, domain);
            this.memory.recordAttempt(item.selector, 'clickable', 'click', fresh.length > 0, fresh.length, fresh, domain);
            if (fresh.length > 0) groupHadSuccess = true;
          }
        }

        if (groupHadSuccess) groupFails = 0; else groupFails++;
      }

      const finalUrls = await this.extractAllUrls();
      diffAndCollect(finalUrls, 'final', pageUrl);

      if (depth < MAX_DEPTH) {
        const containers = pageUrlsLocal
          .filter(u => {
            const cls = this.ai.classifyURL(u, u);
            if (AutonomousScraper.AD_DOMAINS.test(u)) return false;
            const d = this.extractDomain(u);
            if (d === domain && /^\/(login|emision|catalogo|comunidad|peticiones|inicio|registro|profile|cuenta)/i.test(new URL(u).pathname)) return false;
            return (cls.isContainer && (cls.type === 'embed' || cls.type === 'navigation'))
              || this.memory.isKnownContainerDomain(d);
          })
          // Priorizar embeds sobre navigation, tomar solo 1
          .sort((a, b) => {
            const aEmb = /embed|player|reproductor|stream|video/i.test(a) ? 0 : 1;
            const bEmb = /embed|player|reproductor|stream|video/i.test(b) ? 0 : 1;
            return aEmb - bEmb;
          })
          .slice(0, 1);

        for (const containerUrl of containers) {
          if (Date.now() - start > MAX_TIME) break;
          if (visitedPages.has(containerUrl)) continue;
          await this.logStep('dive', this.extractDomain(containerUrl), `Deep: ${containerUrl.slice(0, 50)}`);
          try {
            await explorePage(containerUrl, undefined, depth + 1); visitedPages.add(containerUrl.split("?")[0].replace(/\/\d+$/, "/X")); await this.dynamic.navigate(pageUrl, { timeout: 10000 });
            await this.buildModel();
          } catch { continue; }
        }
      }
    };

    const title = await this.page.title();
    await explorePage(url, this.searchTerm);

    this.categorizeUrls();
    const serverCatalog = this.buildServerCatalog();

    // Aprender cadenas de URL: de donde salieron los servers
    for (const entry of this.urlCollector) {
      const cls = this.ai.classifyURL(entry.url, entry.source);
      if (cls.type === 'embed' || cls.type === 'download') {
        // La fuente contiene "deep:dominio | URL" - extraer el dominio de origen
        const sourceDomain = entry.source.split('|')[1]?.trim() || '';
        if (sourceDomain) {
          this.memory.recordChain(url, entry.url, cls.type === 'embed' ? 'servers' : 'download');
        }
      }
    }
    const duration = Date.now() - start;
    log.info({ steps: this.steps.length, servers: serverCatalog.length, duration }, 'Investigation complete');
    this.memory.forceSave();

    if (this.debug) {
      const findings = this.categorizeUrls();
      const model = this.cachedModel || await this.buildModel();
      const reportPath = this.debug.generateReport({
        url, title,
        steps: this.steps, serverCatalog, findings,
        model: { roles: [...new Set(model.elements.map(e => e.type))], totalElements: model.elements.length, interactions: this.stepCount },
        durationMs: duration,
        streams: [],
        partial: false,
      } as SmartScrapeResult);
      log.info({ reportPath }, 'Debug report ready');
    }

    const model = this.cachedModel || await this.buildModel();
    const streams = this.buildStreamList(serverCatalog);
    const overTime = Date.now() - start > MAX_TIME;
    return {
      url, title,
      steps: this.steps, serverCatalog, streams,
      findings: this.categorizeUrls(),
      model: { roles: [...new Set(model.elements.map(e => e.type))], totalElements: model.elements.length, interactions: this.stepCount },
      durationMs: duration,
      partial: overTime,
    };
  }
  private scoreResults(elements: RawElement[], searchTerm: string): { element: RawElement; score: number; sim: number }[] {
    const pattern = /ver|watch|play|episodio|episode|capitulo|chapter|pelicula|movie|serie|anime|dragon|naruto|bleach|temporada|season|manga|descarg|download/i;
    return elements
      .filter(e => (e.type === 'link' || e.type === 'clickable') && e.text.length > 3 && e.attr?.href && !e.attr.href.startsWith('#') && !e.attr.href.startsWith('javascript:'))
      .map(e => {
        let score = 0;
        const sim = textSimilarity(searchTerm, e.text);
        score += sim * 60;
        if (pattern.test(e.text + (e.attr?.href || '') + (e.class || ''))) score += 20;
        const cls = (e.class || '').split(/\s+/)[0];
        if (cls) score += this.memory.getClassBoost(cls) * 0.5;
        if (/login|iniciar|regist|cuenta|perfil|discord|telegram|facebook|instagram|whatsapp|chat|cookie|privac/i.test(e.text)) score -= 50;
        return { element: e, score, sim };
      })
      .filter(r => r.score > 15 && r.sim > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
  }

  private async safeClick(selector: string): Promise<boolean> {
    return this.safeClickGroup(selector);
  }

  private async safeClickGroup(selector: string): Promise<boolean> {
    try {
      await this.page.waitForSelector(selector, { timeout: 3000 });
      await this.page.click(selector);
      await new Promise(r => setTimeout(r, 1000));
      return true;
    } catch (err) {
      getLogger().debug({ selector, error: (err as Error).message }, 'safeClick: element not clickable');
      return false;
    }
  }

  private async safeClickExplore(selector: string): Promise<boolean> {
    try {
      await this.page.waitForSelector(selector, { timeout: 2000 });
      await this.page.click(selector);
      await new Promise(r => setTimeout(r, 1500));
      return true;
    } catch (err) {
      getLogger().debug({ selector, error: (err as Error).message }, 'safeClickExplore: failed');
      return false;
    }
  }

  private async safeType(selector: string, text: string): Promise<void> {
    try {
      await this.page.waitForSelector(selector, { timeout: 3000 });
      await this.page.click(selector);
      await this.page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLInputElement;
        if (el) { el.value = ''; el.focus(); }
      }, selector);
      await this.page.keyboard.type(text, { delay: 80 });
      // NO presionar Enter — la busqueda es live filter, no form submit
      await new Promise(r => setTimeout(r, 4000));
    } catch (err) {
      getLogger().debug({ selector, error: (err as Error).message }, 'safeType: failed');
    }
  }

  // ============================================================
  // DETECTAR GRUPOS DE BOTONES HERMANOS
  // ============================================================
  private detectGroups(elements: RawElement[]): {
    selector: string;
    label: string;
    count: number;
    labels: string[];
    items: { selector: string; label: string; attr?: Record<string, string> }[];
  }[] {
    const groups: {
      selector: string;
      label: string;
      count: number;
      labels: string[];
    items: { selector: string; label: string; attr?: Record<string, string> }[];
    }[] = [];

    const clickables = elements.filter(e =>
      (e.type === 'clickable' || e.type === 'link') && e.text.length > 1
    );

    // Agrupar por padre comun (misma clase prefijo o mismo container)
    const byParent = new Map<string, RawElement[]>();
    for (const el of clickables) {
      const parentKey = el.parent || 'root';
      if (!byParent.has(parentKey)) byParent.set(parentKey, []);
      byParent.get(parentKey)!.push(el);
    }

    for (const [, siblings] of byParent.entries()) {
      if (siblings.length < 2) continue;

      // Ver si comparten clase base
      const classes = siblings.map(s => (s.class || '').split(/\s+/)[0]).filter(Boolean);
      const uniqueClasses = [...new Set(classes)];

      if (uniqueClasses.length <= 3 && siblings.length >= 2 && siblings.length <= 20) {
        const groupLabel = siblings[0].parent || 'options';
        const skipWords = /login|iniciar|regist|cuenta|discord|telegram|facebook|instagram|chat|cookie|privac|dmca/i;

        const validItems = siblings.filter(s => !skipWords.test(s.text));
        if (validItems.length < 2) continue;

        groups.push({
          selector: validItems[0].parent || 'body',
          label: groupLabel,
          count: validItems.length,
          labels: validItems.map(s => s.text.slice(0, 30)),
          items: validItems.map(s => ({ selector: s.selector, label: s.text.slice(0, 30), attr: s.attr })),
        });
      }
    }

    return groups;
  }

  // ============================================================
  // CONSTRUIR MODELO SEMANTICO DE LA PAGINA
  // ============================================================
  private async buildModel(): Promise<PageModel> {
    const currentUrl = this.page.url();
    if (this.cachedModel && this.lastModelUrl === currentUrl) {
      return this.cachedModel;
    }

    const title = await this.page.title();

    const raw = await this.page.evaluate(`(function() {
      function buildSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        var tag = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          var cls = el.className.toString().trim().split(/\\s+/).filter(function(c) { return c.length > 2 && c.length < 40; })[0];
          if (cls) {
            // Si hay multiples elementos con la misma clase, usar nth-child
            var allSame = document.querySelectorAll(tag + '.' + CSS.escape(cls));
            if (allSame.length > 1) {
              var idx = Array.from(allSame).indexOf(el) + 1;
              return tag + '.' + CSS.escape(cls) + ':nth-of-type(' + idx + ')';
            }
            return tag + '.' + CSS.escape(cls);
          }
        }
        var parent = el.parentElement;
        if (parent) {
          var idx = Array.from(parent.children).indexOf(el) + 1;
          return buildSelector(parent) + ' > ' + tag + ':nth-child(' + idx + ')';
        }
        return tag;
      }

      function getAttributes(el) {
        var attrs = {};
        var names = ['id', 'class', 'href', 'src', 'onclick', 'placeholder', 'type', 'alt', 'title', 'data-url', 'data-src', 'data-anime', 'data-value', 'aria-label', 'role'];
        for (var i = 0; i < names.length; i++) {
          var val = el.getAttribute(names[i]);
          if (val) attrs[names[i]] = val.slice(0, 200);
        }
        // Names heredados del input
        if (el.name) attrs.name = el.name;
        return attrs;
      }

      function isVisible(el) {
        if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
        var style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      }

      function classify(el) {
        var tag = el.tagName.toLowerCase();
        var text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
        var attrs = getAttributes(el);

        if (tag === 'input' || tag === 'textarea') return 'input';
        if (tag === 'select') return 'select';
        if (tag === 'a' || attrs.href) return 'link';
        if (tag === 'button' || attrs.onclick || attrs.role === 'button' || attrs.role === 'tab') return 'clickable';
        if (tag === 'img') return 'image';
        if (tag === 'iframe') return 'iframe';
        if (tag === 'video' || tag === 'audio') return 'media';
        if (tag === 'form') return 'form';
        if (/h[1-6]/i.test(tag)) return 'heading';
        if (tag === 'ul' || tag === 'ol') return 'list';
        if (tag === 'li') return 'list-item';
        if (tag === 'table') return 'table';
        if (text.length > 0 && el.children.length === 0) return 'text';
        return 'container';
      }

      var elements = [];
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!isVisible(el)) continue;
        var type = classify(el);
        if (type === 'container' && el.children.length < 2) continue;
        if (type === 'container' && el.children.length > 50) continue;

        elements.push({
          tag: el.tagName,
          selector: buildSelector(el),
          id: el.id || '',
          class: (el.className && typeof el.className === 'string') ? el.className.toString().trim().slice(0, 80) : '',
          text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
          type: type,
          attr: getAttributes(el),
          children: [],
          parent: el.parentElement ? (el.parentElement.id || el.parentElement.className.toString().split(/\\s+/)[0] || el.parentElement.tagName) : '',
          depth: 0
        });
      }

      return elements.slice(0, 300);
    })()`);

    const elements = raw as RawElement[];
    const semanticTree = this.buildSemanticTree(elements);

    const model = { title, elements, semanticTree };
    this.cachedModel = model;
    this.lastModelUrl = currentUrl;
    return model;
  }

  private buildSemanticTree(elements: RawElement[]): SemanticNode[] {
    const nodes: SemanticNode[] = [];

    const byType = new Map<string, RawElement[]>();
    for (const el of elements) {
      const t = el.type;
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t)!.push(el);
    }

    for (const [type, els] of byType.entries()) {
      if (els.length > 30) continue;

      for (const el of els.slice(0, 15)) {
        const intent = this.ai.classifyElementIntent(el);
        const urls = this.extractUrlsFromElement(el);

        nodes.push({
          role: intent.action,
          selector: el.selector,
          label: el.text || el.attr.alt || el.attr.placeholder || el.attr['aria-label'] || el.tag,
          confidence: intent.confidence,
          children: [],
          actions: el.type === 'clickable' || el.type === 'link' ? ['click'] : [],
          extractedUrls: urls,
        });
      }
    }

    return nodes;
  }

  private extractUrlsFromElement(el: RawElement): string[] {
    const urls: string[] = [];
    const src = el.attr.src || el.attr.href || '';
    if (src && !src.startsWith('#') && !src.startsWith('javascript:')) {
      urls.push(src);
    }
    const onclick = el.attr.onclick || '';
    const matches = onclick.match(/https?:\/\/[^'")\s]+/g);
    if (matches) urls.push(...matches);
    return urls;
  }

  // ============================================================
  // INTERACTUAR CON UN ELEMENTO
  // ============================================================
  private async interact(selector: string, action: string, value?: string): Promise<ActionResult> {
    const log = getLogger();

    try {
      const beforeCount = (await this.page.evaluate(`document.querySelectorAll('*').length`)) as number;

      if (action === 'click') {
        await this.page.click(selector).catch(() => {});
      } else if (action === 'type' && value) {
        await this.page.click(selector).catch(() => {});
        await this.page.keyboard.type(value, { delay: 50 });
      }

      await new Promise(r => setTimeout(r, 1500));

      const afterCount = (await this.page.evaluate(`document.querySelectorAll('*').length`)) as number;
      const newUrls = await this.extractAllUrls();

      return {
        action,
        target: selector,
        success: true,
        changes: Math.abs(afterCount - beforeCount),
        newUrls,
      };
    } catch (err) {
      log.debug({ selector, error: (err as Error).message }, 'Interaction failed');
      return { action, target: selector, success: false, changes: 0, newUrls: [] };
    }
  }

  // ============================================================
  // EXTRACCION DE URLs
  // ============================================================
  private async extractAllUrls(): Promise<string[]> {
    const result = await this.page.evaluate(`(function() {
      var urls = [];
      var seen = {};

      function add(u) {
        if (!u || seen[u]) return;
        if (u.startsWith('#') || u.startsWith('javascript:') || u.startsWith('data:')) return;
        if (u === 'about:blank') return;
        seen[u] = true;
        urls.push(u);
      }

      // 1. Iframes
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        add(iframes[i].src || iframes[i].getAttribute('src') || iframes[i].getAttribute('data-src'));
      }

      // 2. Videos, audio, embed, object
      var mediaEls = document.querySelectorAll('video, video source, audio, audio source, embed, object');
      for (var j = 0; j < mediaEls.length; j++) {
        add(mediaEls[j].src || mediaEls[j].getAttribute('src') || mediaEls[j].getAttribute('data'));
      }

      // 3. Links con href de contenido (descarga, player, etc.)
      var allLinks = document.querySelectorAll('a[href]');
      for (var k = 0; k < Math.min(allLinks.length, 300); k++) {
        add(allLinks[k].href || allLinks[k].getAttribute('href'));
      }

      // 4. Elementos con onclick que contengan URLs
      var clickables = document.querySelectorAll('[onclick]');
      for (var m = 0; m < clickables.length; m++) {
        var oc = clickables[m].getAttribute('onclick') || '';
        // Buscar URLs literales
        var allMatches = oc.match(/https?:\\/\\/[^'")\\s]+/g);
        if (allMatches) { for (var n = 0; n < allMatches.length; n++) add(allMatches[n]); }
        // Buscar URLs escapadas en JSON
        var jsonMatches = oc.match(/https?:\\\\\\/\\\\\\/[^'"\\\\)\\s]+/g);
        if (jsonMatches) {
          for (var p = 0; p < jsonMatches.length; p++) {
            add(jsonMatches[p].replace(/\\\\\\//g, '/'));
          }
        }
      }

      // 5. Elementos con data-url, data-src, data-video, data-embed
      var dataEls = document.querySelectorAll('[data-url], [data-src], [data-video], [data-embed], [data-href], [data-link]');
      for (var q = 0; q < dataEls.length; q++) {
        add(dataEls[q].getAttribute('data-url') || dataEls[q].getAttribute('data-src') || dataEls[q].getAttribute('data-video') || dataEls[q].getAttribute('data-embed') || dataEls[q].getAttribute('data-href') || dataEls[q].getAttribute('data-link'));
      }

      // 6. Scripts con posibles URLs
      var scripts = document.querySelectorAll('script');
      for (var r = 0; r < scripts.length; r++) {
        var txt = scripts[r].textContent || '';
        if (txt.length < 30 || txt.length > 20000) continue;
        var urlPatterns = txt.match(/https?:\\/\\/[^"'\\s<>]{10,300}/g);
        if (urlPatterns) {
          for (var s = 0; s < Math.min(urlPatterns.length, 20); s++) {
            // Solo URLs que parecen de contenido
            var u = urlPatterns[s];
            if (/player|embed|stream|video|download|descarg|mp4|m3u8|hls|source|server|cdn/i.test(u)) {
              add(u);
            }
          }
        }
      }

      return urls;
    })()`);
    return result as string[];
  }

  private collectUrls(urls: string[], source: string, context: string) {
    const MAX_PER_DOMAIN = 5;
    const domainCounts = new Map<string, number>();

    for (const url of urls) {
      if (!url || url === 'about:blank') continue;
      if (AutonomousScraper.AD_DOMAINS.test(url)) continue;

      const domain = this.extractDomain(url);
      if (AutonomousScraper.AD_DOMAINS.test(domain)) continue;
      const count = domainCounts.get(domain) || 0;
      if (count >= MAX_PER_DOMAIN) continue;

      if (!this.urlCollector.find(u => u.url === url)) {
        domainCounts.set(domain, count + 1);
        this.urlCollector.push({ url, category: 'unknown', source: source + ' | ' + context });
      }
    }
  }

  private extractDomain(url: string): string {
    try {
      const host = new URL(url).hostname.replace('www.', '');
      return host;
    } catch {
      return url.slice(0, 40);
    }
  }

  private categorizeUrls() {
    const result = {
      videoUrls: [] as string[],
      downloadUrls: [] as string[],
      serverUrls: [] as string[],
      navigationUrls: [] as string[],
      otherUrls: [] as string[],
    };

    const seen = new Set<string>();

    for (const entry of this.urlCollector) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);

      const cls = this.ai.classifyURL(entry.url, entry.source);

      switch (cls.type) {
        case 'direct-video':
        case 'stream':
          entry.category = cls.type;
          result.videoUrls.push(entry.url);
          break;
        case 'download':
          entry.category = 'download';
          result.downloadUrls.push(entry.url);
          break;
        case 'embed':
          entry.category = 'embed';
          result.serverUrls.push(entry.url);
          break;
        case 'navigation':
          entry.category = 'navigation';
          result.navigationUrls.push(entry.url);
          break;
        default:
          entry.category = cls.type;
          result.otherUrls.push(entry.url);
      }
    }

    result.videoUrls = [...new Set(result.videoUrls)];
    result.downloadUrls = [...new Set(result.downloadUrls)];
    result.serverUrls = [...new Set(result.serverUrls)];
    result.navigationUrls = [...new Set(result.navigationUrls)];
    result.otherUrls = [...new Set(result.otherUrls)];

    return result;
  }

  private buildServerCatalog(): ServerCatalog[] {
    const servers = new Map<string, { url: string; type: string; label: string; directUrl?: string | null; quality?: string; language?: string }[]>();

    for (const entry of this.urlCollector) {
      const domain = this.ai.extractDomain(entry.url);
      const serverName = this.ai.inferServerName(domain);

      if (!servers.has(serverName)) {
        servers.set(serverName, []);
      }

      const list = servers.get(serverName)!;
      const cls = this.ai.classifyURL(entry.url, entry.source);
      const type = cls.type === 'unknown' ? 'other' : cls.type;
      const label = entry.source.split('|')[0].trim().slice(0, 40);

      const normalized = this.streamNormalizer.normalize(entry.url, [label, entry.source]);

      list.push({
        url: entry.url,
        type,
        label,
        quality: normalized.quality,
        language: normalized.language,
      });
    }

    const catalog: ServerCatalog[] = [];
    for (const [name, urls] of servers.entries()) {
      const unique = this.deduplicateUrls(urls);
      catalog.push({ name, domain: name, urls: unique });
    }

    return catalog.sort((a, b) => b.urls.length - a.urls.length);
  }

  private buildStreamList(catalog: ServerCatalog[]): StreamInfo[] {
    const streams: StreamInfo[] = [];
    for (const server of catalog) {
      for (const entry of server.urls) {
        streams.push(this.streamNormalizer.normalize(entry.url, [entry.label, server.name, entry.type]));
      }
    }
    return this.streamNormalizer.sortByPriority(this.streamNormalizer.deduplicate(streams));
  }

  private deduplicateUrls<T extends { url: string; type: string; label: string }>(urls: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];

    for (const item of urls) {
      const fingerprint = this.urlFingerprint(item.url);
      if (seen.has(fingerprint)) continue;

      // Si hay varias URLs del mismo tipo, ver si son realmente distintas
      const existing = result.find(r =>
        this.urlFingerprint(r.url).slice(0, 30) === fingerprint.slice(0, 30)
      );

      if (!existing) {
        seen.add(fingerprint);
        result.push(item);
      }
    }

    return result.slice(0, 8);
  }

  private urlFingerprint(url: string): string {
    try {
      const u = new URL(url);
      // Normalizar: quitar www, ordenar query params
      const params = new URLSearchParams(u.search);
      const sorted = [...params.entries()].sort().map(([k, v]) => k + '=' + v).join('&');
      return u.hostname.replace('www.', '') + u.pathname + '?' + sorted;
    } catch {
      return url.replace(/https?:\/\//, '').split('?')[0].slice(0, 60);
    }
  }

  shouldSkipElement(selector: string, elementType: string, label: string): boolean {
    // 1. Detector de esqueleto (cross-page)
    const domain = this.extractDomain(this.page.url());
    if (this.skeletonDetector.isSkeleton(domain, selector, label)) {
      return true;
    }

    // 2. Clase CSS conocida como fallida
    const cls = (selector.match(/\.([\w-]+)/) || selector.match(/#([\w-]+)/) || [])[1] || '';
    if (cls && this.skipClasses.has(cls)) return true;

    const classBoost = this.memory.getClassBoost(cls);
    if (classBoost > 0 && classBoost <= 5) {
      const fp = this.memory.getDomainFingerprint(this.extractDomain(this.page.url()));
      if (fp) {
        const fails = fp.failedClasses.get(cls) || 0;
        const succs = fp.successfulClasses.get(cls) || 0;
        if (fails >= 3 && succs === 0) {
          this.skipClasses.add(cls);
          return true;
        }
        if (fails > succs * 3 && fails >= 5) {
          this.skipClasses.add(cls);
          getLogger().debug({ class: cls, fails, succs }, 'Skipping known-failure class');
          return true;
        }
      }
    }

    const groupKey = elementType + '|' + label.slice(0, 30);
    if (this.seenGroupPatterns.has(groupKey)) return true;
    return false;
  }

  markGroupSeen(elementType: string, label: string): void {
    this.seenGroupPatterns.add(elementType + '|' + label.slice(0, 30));
  }

  private detectContentGoal(model: PageModel): ContentGoal {
    const texts = model.elements.map(e => e.text + ' ' + e.class).join(' ').toLowerCase();
    const urls = model.elements.flatMap(e => [e.attr.href, e.attr.src, e.attr['data-url']]).filter(Boolean).join(' ').toLowerCase();
    const combined = texts + ' ' + urls;

    const signals: { goal: ContentGoal; score: number }[] = [];

    // Manga: enhanced with chapter/page/reader signals
    let mangaScore = 0;
    if (/manga|manhwa|manhua/i.test(combined)) mangaScore += 25;
    if (/cap[ií]tulo|chapter|ch\.?\s*\d/i.test(combined)) mangaScore += 20;
    if (/tomos|volumen|volume|tankobon|one.?shot|doujin/i.test(combined)) mangaScore += 15;
    if (/p[aá]gina\s*\d|page\s*\d/i.test(combined)) mangaScore += 10;
    if (/\/manga\/|\/capitulo\/|\/chapter\/|\/leer\/|\/read\/|\/reader\//i.test(urls)) mangaScore += 25;
    if (/\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(urls) && model.elements.filter(e => e.type === 'image').length > 10) mangaScore += 15;
    if (mangaScore > 0) signals.push({ goal: 'manga', score: mangaScore });

    // Video/anime
    let videoScore = 0;
    if (/anime|episodio|episode|pel[ií]cula|movie|serie|hentai|dragon\s*ball|naruto|one\s*piece/i.test(combined)) videoScore += 25;
    if (/episodio|episode|temporada|season|ova|ona|pelicula/i.test(combined)) videoScore += 20;
    if (/\/ver\/|\/episodio\/|\/episode\/|\/anime\//i.test(urls)) videoScore += 25;
    if (videoScore > 0) signals.push({ goal: 'video', score: videoScore });

    if (/galer[ií]a|gallery|im[aá]genes|wallpaper|fanart|artwork|fotos/i.test(combined)) {
      signals.push({ goal: 'image', score: 30 });
    }
    if (/descarg|download|zip|rar|torrent|magnet|archivo|file/i.test(combined)) {
      signals.push({ goal: 'download', score: 25 });
    }
    if (/pdf|documento|document|libro|book|biblioteca|library|paper/i.test(combined)) {
      signals.push({ goal: 'document', score: 25 });
    }

    const hasIframes = model.elements.some(e => e.type === 'iframe');
    const hasVideos = model.elements.some(e => e.type === 'media');
    const imgCount = model.elements.filter(e => e.type === 'image').length;
    const linkCount = model.elements.filter(e => e.type === 'link').length;

    if (hasVideos || hasIframes) signals.push({ goal: 'video', score: 20 });
    if (imgCount > 15) signals.push({ goal: 'image', score: 15 });
    if (imgCount > 5 && !hasVideos && !hasIframes) signals.push({ goal: 'manga', score: 10 });
    if (linkCount > 40) signals.push({ goal: 'download', score: 10 });
    if (/\/descargar\/|\/download\/|\.zip|\.rar|\.pdf/i.test(urls)) signals.push({ goal: 'download', score: 20 });

    signals.sort((a, b) => b.score - a.score);
    return signals[0]?.goal || 'video';
  }

  private getContentFilter(): RegExp {
    switch (this.contentGoal) {
      case 'manga':
        return /manga|manhwa|manhua|cap[ií]tulo|chapter|tomos|leer|one.?shot|doujin/i;
      case 'image':
        return /im[aá]gen|wallpaper|fanart|galer[ií]a|gallery|foto|artwork|scan|render/i;
      case 'download':
        return /descarg|download|zip|rar|torrent|magnet|archivo|file|mediafire|mega/i;
      case 'document':
        return /pdf|documento|document|libro|book|paper|biblioteca|library|leer|descarg/i;
      case 'video':
      default:
        return /ver|watch|play|episodio|episode|capitulo|chapter|pelicula|movie|serie|anime|dragon|naruto|bleach|temporada|season/i;
    }
  }

  private async logStep(action: string, target: string, reasoning: string): Promise<void> {
    this.stepCount++;
    const log = getLogger();
    log.info({ step: this.stepCount, action, target }, reasoning);

    this.steps.push({
      step: this.stepCount,
      action,
      target,
      reasoning,
      result: { action, target, success: true, changes: 0, newUrls: [] },
    });

    if (this.debug && /group|chain|dive|detail|deep/i.test(action)) {
      await this.debug.capture(this.page, this.stepCount, action, target, reasoning, []);
    }
  }

  private finalizeResult(url: string, reason: string, start: number): SmartScrapeResult {
    const log = getLogger();
    log.warn({ url, reason }, 'Investigation ended early');

    return {
      url,
      title: '',
      steps: this.steps,
      serverCatalog: [],
      streams: [],
      findings: this.categorizeUrls(),
      model: { roles: [], totalElements: 0, interactions: this.stepCount },
      durationMs: Date.now() - start,
      partial: true,
    };
  }

  async quickInvestigate(url: string): Promise<SmartScrapeResult> {
    const log = getLogger();
    const start = Date.now();
    const QUICK_DEADLINE = 30_000;
    this.urlCollector = [];
    this.steps = [];
    this.stepCount = 0;
    this.requestCount = 0;

    log.info({ url }, 'Quick investigate (fast path, max 30s)');

    try {
      await this.dynamic.navigate(url, { timeout: 15000 });
      await this.dynamic.triggerLazyElements();
      const domain = this.ai.extractDomain(url);
      this.memory.setCurrentDomain(domain);

      const model = await this.buildModel();
      const pageAnalysis = this.pageClassifier.analyze(model.elements, url, model.title);

      const pageUrls = await this.extractAllUrls();
      for (const u of pageUrls) {
        if (u && u !== 'about:blank' && !AutonomousScraper.AD_DOMAINS.test(u)) {
          this.urlCollector.push({ url: u, category: 'quick', source: 'page-scan | ' + url });
        }
      }

      // Content pages: click server buttons, capture network
      if ((pageAnalysis.type as string) === 'content') {
        const groups = this.detectGroups(model.elements);
        for (const group of groups) {
          if (Date.now() - start > QUICK_DEADLINE) break;
          const isServer = /server|servidor|opcion|mirror|source|video|player|download|descarg/i.test(group.label + group.labels.join(' '));
          if (!isServer) continue;

          for (const item of group.items.slice(0, 8)) {
            if (Date.now() - start > QUICK_DEADLINE) break;
            if (this.shouldSkipElement(item.selector, 'click', item.label)) continue;

            try {
              const captured = await this.dynamic.clickAndCaptureUrls(item.selector, 4000);
              for (const u of captured) {
                if (u && u !== 'about:blank' && !AutonomousScraper.AD_DOMAINS.test(u)) {
                  this.urlCollector.push({ url: u, category: 'embed', source: `click:${item.label} | ${domain}` });
                }
              }
              this.memory.recordAttempt(item.selector, 'clickable', 'click', captured.length > 0, captured.length, captured, domain);
            } catch { continue; }
          }
        }
      }

      const allUrls = await this.extractAllUrls();
      for (const u of allUrls) {
        if (u && u !== 'about:blank' && !AutonomousScraper.AD_DOMAINS.test(u)) {
          this.urlCollector.push({ url: u, category: 'final', source: 'quick-scan | ' + url });
        }
      }

      this.categorizeUrls();
      const serverCatalog = this.buildServerCatalog();
      const streams = this.buildStreamList(serverCatalog);
      const duration = Date.now() - start;

      // Learn URL chains even in quick mode
      for (const entry of this.urlCollector) {
        const cls = this.ai.classifyURL(entry.url, entry.source);
        if (cls.type === 'embed' || cls.type === 'download') {
          const sourceDomain = entry.source.split('|')[1]?.trim() || '';
          if (sourceDomain) {
            this.memory.recordChain(url, entry.url, cls.type === 'embed' ? 'servers' : 'download');
          }
        }
      }

      this.memory.forceSave();
      log.info({ servers: serverCatalog.length, duration, partial: duration > QUICK_DEADLINE }, 'Quick investigate complete');

      return {
        url,
        title: model.title,
        steps: this.steps,
        serverCatalog,
        streams,
        findings: this.categorizeUrls(),
        model: { roles: [...new Set(model.elements.map(e => e.type))], totalElements: model.elements.length, interactions: this.stepCount },
        durationMs: duration,
        partial: duration > QUICK_DEADLINE,
      };
    } catch (err) {
      log.error({ url, error: (err as Error).message }, 'Quick investigate failed');
      return this.finalizeResult(url, `error: ${(err as Error).message}`, start);
    }
  }
}






