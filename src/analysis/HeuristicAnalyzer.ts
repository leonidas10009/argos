import type { Page } from 'puppeteer';
import { getLogger } from '../utils/logger';

export interface HeuristicFinding {
  type: string;
  selector: string;
  confidence: number;
  sample: unknown;
  children?: HeuristicFinding[];
}

export interface DomAnalysis {
  url: string;
  title: string;
  pageType: string;
  findings: HeuristicFinding[];
  stats: Record<string, number>;
  recommendations: string[];
}

export class HeuristicAnalyzer {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async analyze(): Promise<DomAnalysis> {
    const log = getLogger();
    log.info('Starting heuristic DOM analysis');

    const raw = await this.page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const candidates: any[] = [];

      // ========================================================
      // HEURISTICA 1: Detectar tarjetas / cards repetitivas
      // ========================================================
      function detectCards() {
        const allElements = Array.from(document.querySelectorAll('*'));
        const classCounts = new Map<string, number>();

        allElements.forEach(el => {
          if (!el.className || typeof el.className !== 'string') return;
          const classes = el.className.toString().trim().split(/\s+/);
          if (classes.length === 0 || classes[0] === '') return;

          for (const cls of classes) {
            if (cls.length < 3 || cls.length > 40) continue;
            classCounts.set(cls, (classCounts.get(cls) || 0) + 1);
          }
        });

        const candidateClasses = Array.from(classCounts.entries())
          .filter(([, count]) => count >= 3 && count <= 500)
          .filter(([cls]) => {
            const lower = cls.toLowerCase();
            const cardKeywords = ['card', 'item', 'entry', 'row', 'result', 'product', 'post', 'list', 'grid', 'cell', 'tile', 'box'];
            return cardKeywords.some(k => lower.includes(k));
          })
          .sort((a, b) => b[1] - a[1]);

        for (const [cls, count] of candidateClasses.slice(0, 5)) {
          const elements = Array.from(document.querySelectorAll('.' + CSS.escape(cls)));
          const first = elements[0];

          const children = Array.from(first?.children || []).slice(0, 6).map(ch => ({
            tag: ch.tagName,
            class: (ch as HTMLElement).className,
            text: (ch as HTMLElement).textContent?.trim()?.slice(0, 60) || '',
          }));

          const innerLinks = first ? Array.from(first.querySelectorAll('a')).length : 0;
          const innerImgs = first ? Array.from(first.querySelectorAll('img')).length : 0;

          let sampleData = null;
          if (elements.length > 0 && first) {
            const dataAttr = first.getAttribute('data-anime') || first.getAttribute('data-item') || first.getAttribute('data-json');
            sampleData = dataAttr ? dataAttr.slice(0, 200) : children;
          }

          candidates.push({
            selector: '.' + cls,
            type: 'card-grid',
            score: Math.min(count * 5, 100),
            count,
            sample: { className: cls, count, sampleData, innerLinks, innerImgs },
          });
        }
      }

      // ========================================================
      // HEURISTICA 2: Detectar listas de enlaces (episodios, servers)
      // ========================================================
      function detectLinkLists() {
        const containers = Array.from(document.querySelectorAll('div, ul, ol, nav, section'));

        for (const container of containers) {
          const links = Array.from(container.querySelectorAll('a[href]'));
          if (links.length < 2 || links.length > 1000) continue;

          const classes = new Map<string, number>();
          links.forEach(a => {
            const cls = (a as HTMLElement).className?.toString()?.trim();
            if (cls) classes.set(cls, (classes.get(cls) || 0) + 1);
          });

          for (const [cls, count] of classes.entries()) {
            if (count >= links.length * 0.7 && cls.length > 2) {
              const sample = links.slice(0, 5).map(a => ({
                text: a.textContent?.trim()?.slice(0, 50) || '',
                href: (a as HTMLAnchorElement).href || a.getAttribute('href')?.slice(0, 80) || '',
              }));

              const parentClass = (container as HTMLElement).className?.toString()?.trim() || container.tagName;

              let listType = 'link-list';
              const lowerParent = parentClass.toLowerCase();
              const lowerTexts = sample.map(s => s.text.toLowerCase()).join(' ');

              if (/episod|capitul|chapter/i.test(lowerParent + lowerTexts)) listType = 'episode-list';
              else if (/server|servidor|player|reproductor|video/i.test(lowerParent + lowerTexts)) listType = 'server-list';
              else if (/nav|menu|header/i.test(lowerParent)) listType = 'navigation';
              else if (/result|search/i.test(lowerParent)) listType = 'search-results';

              candidates.push({
                selector: '.' + CSS.escape(cls),
                type: listType,
                score: Math.min(count * 3, 85),
                count: links.length,
                sample: { parentClass, itemClass: cls, samples: sample },
              });

              break;
            }
          }
        }
      }

      // ========================================================
      // HEURISTICA 3: Detectar iframes / reproductores
      // ========================================================
      function detectPlayers() {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const videos = Array.from(document.querySelectorAll('video'));

        if (iframes.length > 0) {
          const validIframes = iframes.filter(f => {
            const src = (f as HTMLIFrameElement).src || f.getAttribute('src') || f.getAttribute('data-src') || '';
            return src && !src.includes('about:blank');
          });

          if (validIframes.length > 0) {
            candidates.push({
              selector: 'iframe',
              type: 'video-player',
              score: 90,
              count: validIframes.length,
              sample: {
                sources: validIframes.map(f => ({
                  src: ((f as HTMLIFrameElement).src || f.getAttribute('src'))?.slice(0, 120) || '',
                  id: f.id,
                  class: (f as HTMLElement).className,
                  parentClass: (f.parentElement as HTMLElement)?.className?.toString() || '',
                })),
              },
            });
          }

          const parentDivs = new Map<string, { el: Element; iframes: Element[]; buttons: Element[] }>();
          iframes.forEach(f => {
            let p: Element | null = f.parentElement;
            let depth = 0;
            while (p && depth < 5) {
              const cls = (p as HTMLElement).className?.toString()?.trim();
              if (cls && cls.length > 2) {
                const lower = cls.toLowerCase();
                if (/server|servidor|player|reproductor|tab|option|source/i.test(lower)) {
                  if (!parentDivs.has(cls)) {
                    parentDivs.set(cls, { el: p, iframes: [], buttons: [] });
                  }
                  parentDivs.get(cls)!.iframes.push(f);
                  break;
                }
              }
              p = p.parentElement;
              depth++;
            }
          });

          for (const [cls, info] of parentDivs.entries()) {
            const allButtons = Array.from(info.el.querySelectorAll('button, [role="tab"], [role="button"]'));
            candidates.push({
              selector: '.' + CSS.escape(cls),
              type: 'server-container',
              score: 80,
              count: info.iframes.length,
              sample: {
                className: cls,
                iframes: info.iframes.length,
                buttons: allButtons.length,
                buttonTexts: allButtons.slice(0, 8).map(b => (b as HTMLElement).textContent?.trim()?.slice(0, 30)),
              },
            });
          }
        }
      }

      // ========================================================
      // HEURISTICA 4: Detectar paginacion
      // ========================================================
      function detectPagination() {
        const pagElements = Array.from(document.querySelectorAll('[class*="pagin"], [class*="page"], [class*="naveg"]'));
        for (const el of pagElements) {
          const links = Array.from(el.querySelectorAll('a'));
          const buttons = Array.from(el.querySelectorAll('button'));
          const current = el.querySelector('.current, .active, [aria-current]');

          if (links.length >= 2 || buttons.length >= 2) {
            candidates.push({
              selector: '.' + ((el as HTMLElement).className?.toString()?.trim()?.split(/\s+/)[0] || 'pagination'),
              type: 'pagination',
              score: 95,
              count: links.length + buttons.length,
              sample: {
                totalPages: links.length || buttons.length,
                hasCurrent: !!current,
                nextText: Array.from(el.querySelectorAll('a, button')).pop()?.textContent?.trim()?.slice(0, 20) || '',
                prevText: Array.from(el.querySelectorAll('a, button')).shift()?.textContent?.trim()?.slice(0, 20) || '',
              },
            });
            break;
          }
        }
      }

      // ========================================================
      // HEURISTICA 5: Detectar buscadores / filtros
      // ========================================================
      function detectSearchAndFilters() {
        const inputs = Array.from(document.querySelectorAll(
          'input[type="text"], input[type="search"], input[placeholder*="buscar" i], input[placeholder*="search" i], input[id*="filtro"], input[id*="search"], input[id*="buscar"]'
        ));
        for (const input of inputs) {
          const id = input.id || (input as HTMLElement).className?.toString()?.trim();
          if (id) {
            candidates.push({
              selector: '#' + CSS.escape(id),
              type: 'search-input',
              score: 90,
              count: 1,
              sample: {
                id,
                placeholder: input.getAttribute('placeholder') || '',
                type: input.getAttribute('type') || '',
              },
            });
            break;
          }
        }

        const filterGroups = Array.from(document.querySelectorAll('[class*="filtro"], [class*="filter"], [class*="catalog-filters"]'));
        for (const group of filterGroups) {
          const children = Array.from(group.querySelectorAll('select, input, button'));
          if (children.length >= 2) {
            candidates.push({
              selector: '.' + ((group as HTMLElement).className?.toString()?.trim()?.split(/\s+/)[0] || 'filters'),
              type: 'filter-group',
              score: 85,
              count: children.length,
              sample: {
                types: children.map(ch => ch.tagName + (ch.id ? '#' + ch.id : '')),
              },
            });
            break;
          }
        }
      }

      // ========================================================
      // HEURISTICA 6: Detectar metadata (schema.org, JSON-LD, meta tags)
      // ========================================================
      function detectMetadata() {
        const metaTags: Record<string, string> = {};
        const metas = Array.from(document.querySelectorAll('meta[property], meta[name]'));
        metas.forEach(m => {
          const key = m.getAttribute('property') || m.getAttribute('name') || '';
          const content = m.getAttribute('content') || '';
          if (key && content && key.length < 60 && content.length < 200) {
            metaTags[key] = content;
          }
        });

        const jsonLd = document.querySelector('script[type="application/ld+json"]');
        let structuredData = null;
        if (jsonLd) {
          try {
            structuredData = JSON.parse(jsonLd.textContent || '{}');
          } catch { /* ignore */ }
        }

        if (Object.keys(metaTags).length > 0 || structuredData) {
          candidates.push({
            selector: 'meta, script[type="application/ld+json"]',
            type: 'metadata',
            score: 70,
            count: Object.keys(metaTags).length,
            sample: { metaTags, structuredData },
          });
        }
      }

      // ========================================================
      // HEURISTICA 7: Detectar tabs / acordeones
      // ========================================================
      function detectTabs() {
        const tabContainers = Array.from(document.querySelectorAll('[role="tablist"], [class*="tabs"], [class*="pestanas"]'));
        for (const container of tabContainers) {
          const tabs = Array.from(container.querySelectorAll('[role="tab"], button, a'));
          if (tabs.length >= 2) {
            candidates.push({
              selector: '.' + ((container as HTMLElement).className?.toString()?.trim()?.split(/\s+/)[0] || 'tabs'),
              type: 'tabs',
              score: 88,
              count: tabs.length,
              sample: {
                tabTexts: tabs.map(t => (t as HTMLElement).textContent?.trim()?.slice(0, 30)),
              },
            });
            break;
          }
        }
      }

      // Ejecutar todas las heuristicas
      detectCards();
      detectLinkLists();
      detectPlayers();
      detectPagination();
      detectSearchAndFilters();
      detectMetadata();
      detectTabs();

      // Inferir tipo de pagina
      const types = new Map<string, number>();
      candidates.forEach(c => {
        types.set(c.type, (types.get(c.type) || 0) + c.score);
      });

      let pageType = 'generic';
      if (types.has('video-player')) pageType = 'video-player-page';
      else if (types.has('episode-list')) pageType = 'anime-detail-page';
      else if (types.has('card-grid') && types.has('search-input')) pageType = 'catalog-page';
      else if (types.has('card-grid')) pageType = 'listing-page';
      else if (types.has('server-container')) pageType = 'server-selection-page';

      return {
        candidates: candidates.sort((a, b) => b.score - a.score),
        pageType,
        title: document.title,
      };
    });

    const findings: HeuristicFinding[] = raw.candidates.map(c => ({
      type: c.type,
      selector: c.selector,
      confidence: c.score,
      sample: c.sample,
    }));

    const stats = {
      totalFindings: findings.length,
      highConfidence: findings.filter(f => f.confidence >= 80).length,
      mediumConfidence: findings.filter(f => f.confidence >= 50 && f.confidence < 80).length,
      lowConfidence: findings.filter(f => f.confidence < 50).length,
    };

    const recommendations = this.generateRecommendations(findings);

    log.info({ pageType: raw.pageType, findings: findings.length }, 'Heuristic analysis complete');

    return {
      url: this.page.url(),
      title: raw.title,
      pageType: raw.pageType,
      findings,
      stats,
      recommendations,
    };
  }

  private generateRecommendations(findings: HeuristicFinding[]): string[] {
    const recs: string[] = [];

    const hasEpisodes = findings.some(f => f.type === 'episode-list');
    const hasCards = findings.some(f => f.type === 'card-grid');
    const hasPlayers = findings.some(f => f.type === 'video-player');
    const hasServers = findings.some(f => f.type === 'server-container');
    const hasSearch = findings.some(f => f.type === 'search-input');
    const hasPagination = findings.some(f => f.type === 'pagination');
    const hasTabs = findings.some(f => f.type === 'tabs');

    if (hasCards && hasSearch) {
      recs.push('Catalogo detectado: usar filtro de busqueda para encontrar item');
    }
    if (hasEpisodes) {
      recs.push('Lista de episodios detectada: extraer y ordenar');
    }
    if (hasServers) {
      recs.push('Contenedores de servidores detectados: interactuar con tabs/botones');
    }
    if (hasPlayers && !hasServers) {
      recs.push('Reproductor detectado: extraer iframe directamente');
    }
    if (hasPagination) {
      recs.push('Paginacion detectada: navegar paginas secuencialmente');
    }
    if (hasTabs) {
      recs.push('Tabs detectados: clickear cada tab para revelar contenido');
    }
    if (recs.length === 0) {
      recs.push('Estructura no reconocida: usar analisis manual de DOM');
    }

    return recs;
  }

  async extractByHeuristic(type: string): Promise<unknown> {
    const log = getLogger();

    switch (type) {
      case 'card-grid': return this.extractCardGrid();
      case 'episode-list': return this.extractEpisodeList();
      case 'video-player': return this.extractVideoPlayers();
      case 'server-container': return this.extractServerContainers();
      case 'pagination': return this.extractPagination();
      default:
        log.warn(`No extractor for type: ${type}`);
        return null;
    }
  }

  private async extractCardGrid(): Promise<unknown> {
    // Use a raw string evaluation to avoid TypeScript DOM iterator issues
    return this.page.evaluate(`
      (function() {
        var cards = document.querySelectorAll('[class*="card"], [class*="item"]');
        var results = [];
        for (var i = 0; i < Math.min(cards.length, 50); i++) {
          var c = cards[i];
          var data = c.getAttribute('data-anime') || c.getAttribute('data-item') || c.getAttribute('data-json');
          if (data) {
            try { results.push(JSON.parse(data)); } catch(e) { results.push({raw: data}); }
          }
        }
        return results;
      })()
    `);
  }

  private async extractEpisodeList(): Promise<unknown> {
    return this.page.evaluate(`
      (function() {
        var links = document.querySelectorAll('[class*="episod"] a, [class*="capitul"] a');
        var results = [];
        for (var i = 0; i < links.length; i++) {
          var a = links[i];
          results.push({
            text: (a.textContent || '').trim().slice(0, 60),
            href: a.href || a.getAttribute('href') || ''
          });
        }
        return results;
      })()
    `);
  }

  private async extractVideoPlayers(): Promise<unknown> {
    return this.page.evaluate(`
      (function() {
        var iframes = document.querySelectorAll('iframe');
        var results = [];
        for (var i = 0; i < iframes.length; i++) {
          var f = iframes[i];
          var src = f.src || f.getAttribute('src') || f.getAttribute('data-src') || '';
          if (src && src.indexOf('about:blank') === -1) {
            results.push({
              src: src,
              width: f.width,
              height: f.height,
              parentClass: (f.parentElement ? f.parentElement.className : '') || ''
            });
          }
        }
        return results;
      })()
    `);
  }

  private async extractServerContainers(): Promise<unknown> {
    return this.page.evaluate(`
      (function() {
        var containers = document.querySelectorAll('[class*="server"], [class*="servidor"], [class*="player"], [class*="reproductor"]');
        var results = [];
        for (var i = 0; i < containers.length; i++) {
          var c = containers[i];
          var iframes = c.querySelectorAll('iframe');
          var buttons = c.querySelectorAll('button, [role="tab"]');
          var iframeData = [];
          for (var j = 0; j < iframes.length; j++) {
            var f = iframes[j];
            iframeData.push({ src: f.src || f.getAttribute('src') || f.getAttribute('data-src') || '' });
          }
          var tabData = [];
          for (var k = 0; k < buttons.length; k++) {
            tabData.push((buttons[k].textContent || '').trim());
          }
          results.push({ className: c.className, iframes: iframeData, tabs: tabData });
        }
        return results;
      })()
    `);
  }

  private async extractPagination(): Promise<unknown> {
    return this.page.evaluate(`
      (function() {
        var pag = document.querySelector('[class*="pagin"], [class*="page"], [class*="naveg"]');
        if (!pag) return null;
        var links = pag.querySelectorAll('a, button');
        var results = [];
        for (var i = 0; i < links.length; i++) {
          var l = links[i];
          results.push({
            text: (l.textContent || '').trim().slice(0, 20),
            href: l.href || '',
            isCurrent: l.className.indexOf('current') !== -1 || l.className.indexOf('active') !== -1 || l.getAttribute('aria-current') !== null
          });
        }
        return { total: links.length, items: results };
      })()
    `);
  }
}
