import type { RawElement } from './types';

export type PageType = 'listing' | 'detail' | 'content' | 'search' | 'unknown';

export interface PageAnalysis {
  type: PageType;
  confidence: number;
  signals: string[];
  suggestedStrategy: 'extract-links' | 'find-episodes' | 'click-servers' | 'search-results' | 'explore';
  keyElements: { type: string; selector: string; label: string; count: number }[];
}

export class PageTypeClassifier {
  analyze(elements: RawElement[], pageUrl: string, pageTitle: string): PageAnalysis {
    const signals: string[] = [];
    const keyElements: PageAnalysis['keyElements'] = [];

    // Contar tipos de elementos
    const links = elements.filter(e => e.type === 'link' && e.attr.href && !e.attr.href.startsWith('#'));
    const clickables = elements.filter(e => e.type === 'clickable');
    const iframes = elements.filter(e => e.type === 'iframe');
    const inputs = elements.filter(e => e.type === 'input');
    const headings = elements.filter(e => e.type === 'heading');
    const images = elements.filter(e => e.type === 'image');
    const listItems = elements.filter(e => e.type === 'list-item');

    // === DETECTAR LISTING (home/catalog) ===
    let listingScore = 0;

    // Muchas tarjetas/items con misma clase
    const cardClasses = this.findRepeatingClasses(elements, 4);
    if (cardClasses.length > 0) {
      listingScore += 30;
      signals.push(`cards:${cardClasses[0]!}`);
      keyElements.push({ type: 'card-grid', selector: '.' + cardClasses[0]!, label: cardClasses[0]!, count: this.countByClass(elements, cardClasses[0]!) });
    }

    // Muchos links de navegacion
    if (links.length > 20) { listingScore += 15; signals.push('many-links'); }

    // Paginacion
    const hasPagination = elements.some(e => /pagin|page|naveg/i.test(e.class + e.text));
    if (hasPagination) { listingScore += 15; signals.push('pagination'); }

    // Buscador visible
    if (inputs.length > 0) { listingScore += 10; signals.push('search-input'); }

    // URLs con patron de listado
    const urlLower = pageUrl.toLowerCase();
    if (/catalogo|directory|browse|list|home|index|inicio/i.test(urlLower)) { listingScore += 15; signals.push('url:catalog'); }

    // === DETECTAR DETAIL (anime info, episode list) ===
    let detailScore = 0;

    // Lista de episodios numerados
    const episodePattern = listItems.filter(e => /\d+/.test(e.text) && /episod|capitul|chapter|season|temporada|ep\.?\s*\d|cap\.?\s*\d/i.test(e.text + e.class));
    if (episodePattern.length >= 3) {
      detailScore += 40;
      signals.push(`episodes:${episodePattern.length}`);
      keyElements.push({ type: 'episode-list', selector: episodePattern[0]!.parent || 'ul', label: 'Episodes', count: episodePattern.length });
    }

    // Sinopsis larga
    const longTexts = elements.filter(e => e.type === 'text' && e.text.length > 80);
    if (longTexts.length >= 1) { detailScore += 10; signals.push('synopsis'); }

    // Tags de genero
    const genreTags = elements.filter(e => /accion|comedia|drama|romance|fantasia|terror|aventura|action|comedy|drama|romance|fantasy|horror|adventure|shounen|shoujo|seinen|josei/i.test(e.text) && e.text.length < 20);
    if (genreTags.length >= 2) { detailScore += 15; signals.push(`genres:${genreTags.length}`); }

    // Tabs de temporada
    const seasonTabs = elements.filter(e => /season|temporada|temp\.?\s*\d/i.test(e.text + e.class));
    if (seasonTabs.length >= 1) { detailScore += 15; signals.push('season-tabs'); }

    // URL con patron de detalle
    if (/\/anime\/|\/ver\/|\/detail\/|\/show\/|\/series\//i.test(urlLower) && !/episode|capitulo/i.test(urlLower)) {
      detailScore += 15; signals.push('url:detail');
    }

    // === DETECTAR CONTENT (episode with player) ===
    let contentScore = 0;

    // Tiene iframes (reproductor)
    if (iframes.length > 0) {
      contentScore += 35;
      signals.push(`iframes:${iframes.length}`);
      keyElements.push({ type: 'player', selector: 'iframe', label: 'Video Player', count: iframes.length });
    }

    // Tiene video/audio tags
    const media = elements.filter(e => e.type === 'media');
    if (media.length > 0) { contentScore += 35; signals.push('video-tag'); }

    // Botones de servidor o links de descarga/embed
    const serverButtons = clickables.filter(e => /server|servidor|opcion|mirror|source|fuente|calidad|quality|HD|SD|720|1080/i.test(e.text + e.class));
    if (serverButtons.length >= 2) {
      contentScore += 30;
      signals.push(`servers:${serverButtons.length}`);
      keyElements.push({ type: 'server-buttons', selector: serverButtons[0]!.selector, label: 'Servers', count: serverButtons.length });
    }

    // Boton de descarga
    const downloadBtn = clickables.filter(e => /download|descarg/i.test(e.text + e.class));
    if (downloadBtn.length > 0) { contentScore += 10; signals.push('download-btn'); }

    // Selector de idioma
    const langSelectors = elements.filter(e => /idioma|language|lang|audio|dub|sub|latino|castellano|japones|english/i.test(e.text + e.class));
    if (langSelectors.length >= 1) { contentScore += 10; signals.push('language-selector'); }

    // URL con patron de episodio/ver/watch
    if (/episode|episodio|capitulo|chapter|ver\//i.test(urlLower)) {
      contentScore += 20; signals.push('url:episode');
    }
    // URL de pelicula/serie (watch/view/player)
    if (/\/(ver|watch|play|player|video|pelicula|movie)\//i.test(urlLower)) {
      contentScore += 25; signals.push('url:watch');
    }
    // Links a embeds/players en la pagina
    const embedLinks = links.filter(l => /embed|player|video|stream|watch|ver/i.test((l.attr.href || '') + l.text));
    if (embedLinks.length >= 2) {
      contentScore += 20; signals.push('embed-links');
    }

    // === DETECTAR SEARCH ===
    let searchScore = 0;
    if (inputs.length > 0 && /search|buscar|busqueda/i.test(pageTitle + ' ' + inputs.map(e => e.attr.placeholder || '').join(' '))) {
      searchScore += 30; signals.push('search-active');
    }
    if (/search|buscar|busqueda|find|query|q=/i.test(urlLower)) {
      searchScore += 30; signals.push('url:search');
    }

    // === DECIDIR ===
    // Boost content when URL clearly indicates a watch/view page
    const isWatchUrl = /\/(ver|watch|play|player|video)\//i.test(urlLower);
    if (isWatchUrl && contentScore < 50) {
      contentScore = Math.max(contentScore, 50); // Floor for watch pages
    }

    const scores = [
      { type: 'listing' as PageType, score: listingScore },
      { type: 'detail' as PageType, score: detailScore },
      { type: 'content' as PageType, score: contentScore },
      { type: 'search' as PageType, score: searchScore },
    ];
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0]!;

    let type: PageType = 'unknown';
    let confidence = 0;
    let suggestedStrategy: PageAnalysis['suggestedStrategy'] = 'explore';

    if (best.score >= 40) {
      type = best.type;
      confidence = Math.min(100, best.score);
      switch (type) {
        case 'listing': suggestedStrategy = 'extract-links'; break;
        case 'detail': suggestedStrategy = 'find-episodes'; break;
        case 'content': suggestedStrategy = 'click-servers'; break;
        case 'search': suggestedStrategy = 'search-results'; break;
      }
    } else if (best.score >= 20) {
      type = best.type;
      confidence = best.score;
      suggestedStrategy = 'explore';
    }

    return { type, confidence, signals, suggestedStrategy, keyElements };
  }

  private findRepeatingClasses(elements: RawElement[], minRepeats: number): string[] {
    const classCounts = new Map<string, number>();
    for (const el of elements) {
      const cls = (el.class || '').split(/\s+/)[0];
      if (cls && cls.length > 2 && cls.length < 40) {
        classCounts.set(cls, (classCounts.get(cls) || 0) + 1);
      }
    }
    return [...classCounts.entries()]
      .filter(([, count]) => count >= minRepeats)
      .sort((a, b) => b[1]! - a[1]!)
      .slice(0, 5)
      .map(([cls]) => cls);
  }

  private countByClass(elements: RawElement[], cls: string): number {
    return elements.filter(e => (e.class || '').includes(cls)).length;
  }
}
