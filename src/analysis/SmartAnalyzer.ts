import type { RawElement } from './types';
import type { SessionMemory } from './SessionMemory';

// ============================================================
// TIPOS
// ============================================================

export type ElementAction =
  | 'play-video'
  | 'switch-server'
  | 'change-language'
  | 'download'
  | 'navigate-episode'
  | 'navigate-page'
  | 'search'
  | 'filter'
  | 'sort'
  | 'login'
  | 'social'
  | 'ad'
  | 'unknown';

export interface ElementIntent {
  action: ElementAction;
  confidence: number;
  signals: string[];
}

export interface ContentScore {
  score: number;
  relevance: 'high' | 'medium' | 'low' | 'skip';
  factors: { factor: string; contribution: number }[];
}

export type URLType =
  | 'embed'
  | 'direct-video'
  | 'stream'
  | 'download'
  | 'navigation'
  | 'social'
  | 'cdn'
  | 'tracking'
  | 'unknown';

export interface URLClassification {
  type: URLType;
  confidence: number;
  isContainer: boolean;
  signals: string[];
}

export type PageZoneType = 'header' | 'nav' | 'content' | 'sidebar' | 'footer' | 'unknown';

export interface PageZone {
  zone: PageZoneType;
  confidence: number;
}

export interface AnalysisReport {
  elementIntents: Map<string, ElementIntent>;
  contentScores: Map<string, ContentScore>;
  urlClassifications: Map<string, URLClassification>;
  pageZones: Map<string, PageZone>;
  summary: {
    dominantZone: PageZoneType;
    contentElementCount: number;
    highRelevanceCount: number;
    serverElements: RawElement[];
    videoElements: RawElement[];
    downloadElements: RawElement[];
    navigationElements: RawElement[];
  };
}

// ============================================================
// DICCIONARIOS SEMANTICOS (expandibles)
// ============================================================

const ACTION_PATTERNS: Record<ElementAction, { words: RegExp[]; classPatterns: RegExp[]; attrPatterns: RegExp[]; baseScore: number }> = {
  'play-video': {
    words: [/play|reproduc|ver|watch|mirar|reproducir|stream|video|pelicula|movie|mirar/i],
    classPatterns: [/player|video|reproduc|stream|watch/i],
    attrPatterns: [/play|video|stream|reproduc|embed/i],
    baseScore: 25,
  },
  'switch-server': {
    words: [/server|servidor|opcion|mirror|fuente|source|cdn|host|altern/i],
    classPatterns: [/server|servidor|mirror|source|option/i],
    attrPatterns: [/server|source|mirror|cdn/i],
    baseScore: 25,
  },
  'change-language': {
    words: [/idioma|language|lang|audio|doblaje|dub|sub|subtit|castellano|latino|español|english|japanese|portuguese/i],
    classPatterns: [/idioma|language|lang|audio|dub/i],
    attrPatterns: [/lang|language|audio|dub/i],
    baseScore: 25,
  },
  'download': {
    words: [/download|descarg|bajar|descarga|guardar/i],
    classPatterns: [/download|descarg|btn-descarg/i],
    attrPatterns: [/download|descarg/i],
    baseScore: 25,
  },
  'navigate-episode': {
    words: [/episodio|episode|capitulo|chapter|cap\.?\s*\d|ep\.?\s*\d|^\d{1,4}$/i],
    classPatterns: [/episod|episode|capitul|chapter/i],
    attrPatterns: [/episod|episode|chapter/i],
    baseScore: 20,
  },
  'navigate-page': {
    words: [/siguiente|next|anterior|prev|»|«|pagina|page|catalogo|catalog|inicio|home/i],
    classPatterns: [/pagin|page|nav|next|prev|naveg/i],
    attrPatterns: [/page|nav|next|prev/i],
    baseScore: 15,
  },
  'search': {
    words: [/buscar|search|busqueda|find|encontrar|filt/i],
    classPatterns: [/search|buscar|filtro|filter|find/i],
    attrPatterns: [/search|buscar|filter/i],
    baseScore: 30,
  },
  'filter': {
    words: [/filtro|filter|categoria|category|genero|genre|año|year|tipo|type|orden/i],
    classPatterns: [/filter|filtro|categor|genero|genre/i],
    attrPatterns: [/filter|categor/i],
    baseScore: 20,
  },
  'sort': {
    words: [/ordenar|sort|orden|ascendente|descendente|asc|desc|rating|popular/i],
    classPatterns: [/sort|orden/i],
    attrPatterns: [/sort|order/i],
    baseScore: 15,
  },
  'login': {
    words: [/login|iniciar|regist|cuenta|account|sign.?in|sign.?up|perfil|profile/i],
    classPatterns: [/login|auth|account|user|sign/i],
    attrPatterns: [/login|auth|account/i],
    baseScore: 20,
  },
  'social': {
    words: [/discord|telegram|facebook|twitter|instagram|whatsapp|reddit|youtube|tiktok/i],
    classPatterns: [/social|share|discord|telegram/i],
    attrPatterns: [/social|share/i],
    baseScore: 20,
  },
  'ad': {
    words: [/publicidad|anuncio|advert|patrocin/i],
    classPatterns: [/ad|ads|banner|publi|advert/i],
    attrPatterns: [/ad|ads/i],
    baseScore: 15,
  },
  'unknown': {
    words: [],
    classPatterns: [],
    attrPatterns: [],
    baseScore: 0,
  },
};

const URL_DOMAIN_KB: Record<string, { type: URLType; isContainer: boolean }> = {
  'streamtape.com': { type: 'embed', isContainer: true },
  'streamtape.net': { type: 'embed', isContainer: true },
  'uqload.com': { type: 'embed', isContainer: true },
  'uqload.co': { type: 'embed', isContainer: true },
  'ok.ru': { type: 'embed', isContainer: true },
  'mega.nz': { type: 'download', isContainer: true },
  'mega.co.nz': { type: 'download', isContainer: true },
  'yourupload.com': { type: 'embed', isContainer: true },
  'swhoi.com': { type: 'embed', isContainer: true },
  'netu.tv': { type: 'embed', isContainer: true },
  'netu.io': { type: 'embed', isContainer: true },
  'filemoon.sx': { type: 'embed', isContainer: true },
  'filemoon.to': { type: 'embed', isContainer: true },
  'streamwish.to': { type: 'embed', isContainer: true },
  'embedwish.com': { type: 'embed', isContainer: true },
  'cdnwish.com': { type: 'cdn', isContainer: false },
  'hgcloud.to': { type: 'embed', isContainer: true },
  'bysekoze.com': { type: 'embed', isContainer: true },
  'hqq.tv': { type: 'embed', isContainer: true },
  'hqq.watch': { type: 'embed', isContainer: true },
  'nyuu.streamhj.top': { type: 'embed', isContainer: true },
  'multiplayer.streamhj.top': { type: 'embed', isContainer: true },
  'descargas.streamhj.top': { type: 'download', isContainer: true },
  'descargas.henaojara.com': { type: 'download', isContainer: true },
  'discord.com': { type: 'social', isContainer: false },
  'discord.gg': { type: 'social', isContainer: false },
  'telegram.me': { type: 'social', isContainer: false },
  't.me': { type: 'social', isContainer: false },
  'facebook.com': { type: 'social', isContainer: false },
  'instagram.com': { type: 'social', isContainer: false },
  'twitter.com': { type: 'social', isContainer: false },
  'x.com': { type: 'social', isContainer: false },
  'youtube.com': { type: 'direct-video', isContainer: false },
  'youtu.be': { type: 'direct-video', isContainer: false },
  'google.com': { type: 'tracking', isContainer: false },
  'googletagmanager.com': { type: 'tracking', isContainer: false },
  'doubleclick.net': { type: 'tracking', isContainer: false },
  'googlesyndication.com': { type: 'tracking', isContainer: false },
  'cloudflare.com': { type: 'cdn', isContainer: false },
  'jsdelivr.net': { type: 'cdn', isContainer: false },
  'cdnjs.com': { type: 'cdn', isContainer: false },
  'unpkg.com': { type: 'cdn', isContainer: false },

  // ─── Extended from ovnivers (+55 dominios) ───
  'mp4upload.com': { type: 'embed', isContainer: true },
  'dood.so': { type: 'embed', isContainer: true },
  'dood.ws': { type: 'embed', isContainer: true },
  'dood.wf': { type: 'embed', isContainer: true },
  'dood.re': { type: 'embed', isContainer: true },
  'dood.sh': { type: 'embed', isContainer: true },
  'dood.la': { type: 'embed', isContainer: true },
  'dood.to': { type: 'embed', isContainer: true },
  'dood.pm': { type: 'embed', isContainer: true },
  'dood.yt': { type: 'embed', isContainer: true },
  'mixdrop.co': { type: 'embed', isContainer: true },
  'mixdrop.ag': { type: 'embed', isContainer: true },
  'mixdrop.vc': { type: 'embed', isContainer: true },
  'mixdrop.to': { type: 'embed', isContainer: true },
  'mixdrop.ch': { type: 'embed', isContainer: true },
  'mixdrop.gl': { type: 'embed', isContainer: true },
  'voe.sx': { type: 'embed', isContainer: true },
  'voe.su': { type: 'embed', isContainer: true },
  'vidhide.com': { type: 'embed', isContainer: true },
  'vidmoly.to': { type: 'embed', isContainer: true },
  'vidmoly.net': { type: 'embed', isContainer: true },
  'vidpro.com': { type: 'embed', isContainer: true },
  'vidguard.net': { type: 'embed', isContainer: true },
  'upstream.to': { type: 'embed', isContainer: true },
  'uptostream.to': { type: 'embed', isContainer: true },
  'uptobox.com': { type: 'embed', isContainer: true },
  'vidoza.net': { type: 'embed', isContainer: true },
  'vidozahd.com': { type: 'embed', isContainer: true },
  'vidlox.me': { type: 'embed', isContainer: true },
  'vidlox.tv': { type: 'embed', isContainer: true },
  'vidlox.net': { type: 'embed', isContainer: true },
  'vidfast.co': { type: 'embed', isContainer: true },
  'sendvid.com': { type: 'embed', isContainer: true },
  'fembed.com': { type: 'embed', isContainer: true },
  'fembed.net': { type: 'embed', isContainer: true },
  'feurl.com': { type: 'embed', isContainer: true },
  'burstcloud.cc': { type: 'embed', isContainer: true },
  'burstcloud.to': { type: 'embed', isContainer: true },
  'gounlimited.to': { type: 'embed', isContainer: true },
  'hydrax.net': { type: 'embed', isContainer: true },
  'playhydrax.com': { type: 'embed', isContainer: true },
  'sbembed.com': { type: 'embed', isContainer: true },
  'sbembed1.com': { type: 'embed', isContainer: true },
  'sbplay.org': { type: 'embed', isContainer: true },
  'sbplay1.com': { type: 'embed', isContainer: true },
  'sbplay2.com': { type: 'embed', isContainer: true },
  'sbplay3.com': { type: 'embed', isContainer: true },
  'streamlare.com': { type: 'embed', isContainer: true },
  'wolfmax4k.com': { type: 'embed', isContainer: true },
  'vudeo.net': { type: 'embed', isContainer: true },
  'sfastwish.com': { type: 'embed', isContainer: true },
  'flaswish.com': { type: 'embed', isContainer: true },
  'jawcloud.co': { type: 'embed', isContainer: true },
  'jaw.cloud': { type: 'embed', isContainer: true },
  'tapecontent.net': { type: 'embed', isContainer: true },
  'stpete.net': { type: 'embed', isContainer: true },
  'mystream.to': { type: 'embed', isContainer: true },

  // Anime sites
  'animejara.com': { type: 'navigation', isContainer: true },
  'henaojara.com': { type: 'navigation', isContainer: true },
  'tioanime.com': { type: 'navigation', isContainer: true },
  'animeflv.net': { type: 'navigation', isContainer: true },
  'jkanime.net': { type: 'navigation', isContainer: true },
  'monoschinos.com': { type: 'navigation', isContainer: true },
  'monoschinos2.net': { type: 'navigation', isContainer: true },
  'animeav1.com': { type: 'navigation', isContainer: true },
  'anime-jl.net': { type: 'navigation', isContainer: true },
  'latanime.org': { type: 'navigation', isContainer: true },
  'animeonline.ninja': { type: 'navigation', isContainer: true },
  'estrenosanime.net': { type: 'navigation', isContainer: true },
  'tiodonghua.com': { type: 'navigation', isContainer: true },
  'mundodonghua.com': { type: 'navigation', isContainer: true },

  // Download/file hosts
  'mediafire.com': { type: 'download', isContainer: true },
  'drive.google.com': { type: 'download', isContainer: true },
  'dropbox.com': { type: 'download', isContainer: true },
  '1fichier.com': { type: 'download', isContainer: true },
  'zippyshare.com': { type: 'download', isContainer: true },

  'dailymotion.com': { type: 'embed', isContainer: true },
  'vimeo.com': { type: 'embed', isContainer: true },
  'vidcloud.tv': { type: 'embed', isContainer: true },
};

const ZONE_PATTERNS: Record<PageZoneType, { classPatterns: RegExp[]; tagPatterns: RegExp[]; attrPatterns: RegExp[] }> = {
  'header': {
    classPatterns: [/header|top|navbar|nav.?bar|masthead|banner/i],
    tagPatterns: [/header/i],
    attrPatterns: [/banner|header/i],
  },
  'nav': {
    classPatterns: [/nav|menu|sidebar|side.?bar/i],
    tagPatterns: [/nav|aside/i],
    attrPatterns: [/navigation|menu/i],
  },
  'content': {
    classPatterns: [/content|main|body|article|post|entry|principal|container|wrapper/i],
    tagPatterns: [/main|article|section/i],
    attrPatterns: [/main|content/i],
  },
  'sidebar': {
    classPatterns: [/sidebar|side.?bar|widget|aside/i],
    tagPatterns: [/aside/i],
    attrPatterns: [/sidebar|complementary/i],
  },
  'footer': {
    classPatterns: [/footer|bottom|pie/i],
    tagPatterns: [/footer/i],
    attrPatterns: [/footer|contentinfo/i],
  },
  'unknown': {
    classPatterns: [],
    tagPatterns: [],
    attrPatterns: [],
  },
};

// ============================================================
// ANALIZADOR PRINCIPAL
// ============================================================

export class SmartAnalyzer {
  private urlCache = new Map<string, URLClassification>();
  private intentCache = new Map<string, ElementIntent>();

  // ============================================================
  // CLASIFICACION DE INTENCION DE ELEMENTOS
  // ============================================================

  classifyElementIntent(el: RawElement): ElementIntent {
    const cacheKey = el.selector + '|' + el.text;
    const cached = this.intentCache.get(cacheKey);
    if (cached) return cached;

    const combined = this.buildSignalText(el);
    const results: { action: ElementAction; score: number; signals: string[] }[] = [];

    for (const [action, patterns] of Object.entries(ACTION_PATTERNS)) {
      if (action === 'unknown') continue;
      const act = action as ElementAction;
      let score = patterns.baseScore;
      const signals: string[] = [];

      for (const re of patterns.words) {
        if (re.test(combined.text)) {
          score += 15;
          signals.push(`word:${re.source.slice(1, -1)}`);
        }
      }
      for (const re of patterns.classPatterns) {
        if (re.test(combined.classes)) {
          score += 12;
          signals.push(`class:${re.source.slice(1, -1)}`);
        }
      }
      for (const re of patterns.attrPatterns) {
        if (re.test(combined.attrs)) {
          score += 8;
          signals.push(`attr:${re.source.slice(1, -1)}`);
        }
      }

      // Bonus por elemento tipo clickable/link/button
      if (el.type === 'clickable' || el.type === 'link') {
        score += 5;
      }

      // Penalizacion si es solo texto sin accion
      if (el.type === 'text' || el.type === 'container') {
        score -= 10;
      }

      results.push({ action: act, score: Math.min(100, Math.max(0, score)), signals });
    }

    results.sort((a, b) => b.score - a.score);
    const best = results[0]!;

    const intent: ElementIntent = best && best.score >= 35
      ? { action: best.action, confidence: best.score, signals: best.signals }
      : { action: 'unknown', confidence: 10, signals: [] };

    this.intentCache.set(cacheKey, intent);
    return intent;
  }

  // ============================================================
  // SCORING DE RELEVANCIA DE CONTENIDO
  // ============================================================

  scoreContentRelevance(el: RawElement, memory?: SessionMemory): ContentScore {
    const factors: { factor: string; contribution: number }[] = [];
    let total = 0;

    // Factor 1: Intencion conocida
    const intent = this.classifyElementIntent(el);
    const intentScores: Record<string, number> = {
      'play-video': 30,
      'switch-server': 30,
      'download': 25,
      'navigate-episode': 20,
      'change-language': 18,
      'search': 10,
      'filter': 12,
      'sort': 5,
      'navigate-page': 8,
      'login': -20,
      'social': -15,
      'ad': -25,
      'unknown': 5,
    };
    const intentScore = intentScores[intent.action] || 5;
    total += intentScore;
    factors.push({ factor: `intent:${intent.action}`, contribution: intentScore });

    // Factor 2: Tipo de elemento
    const typeScores: Record<string, number> = {
      'clickable': 15,
      'link': 15,
      'list-item': 12,
      'input': 8,
      'select': 8,
      'iframe': 25,
      'video': 30,
      'media': 28,
      'heading': 3,
      'text': 0,
      'image': 3,
      'container': -5,
    };
    const typeScore = typeScores[el.type] || 0;
    total += typeScore;
    factors.push({ factor: `type:${el.type}`, contribution: typeScore });

    // Factor 3: Tiene URLs (href, src, onclick con URLs)
    const urls = this.extractElementUrls(el);
    if (urls.length > 0) {
      const urlScore = Math.min(urls.length * 10, 30);
      total += urlScore;
      factors.push({ factor: 'has-urls', contribution: urlScore });
    }

    // Factor 4: Posicion en el DOM (profundidad)
    if (el.depth <= 3) {
      total += 8;
      factors.push({ factor: 'shallow-depth', contribution: 8 });
    } else if (el.depth > 10) {
      total -= 5;
      factors.push({ factor: 'deep-depth', contribution: -5 });
    }

    // Factor 5: Longitud del texto (nombres cortos = mas probable que sea accionable)
    if (el.text.length >= 2 && el.text.length <= 40) {
      total += 5;
      factors.push({ factor: 'good-text-length', contribution: 5 });
    }

    // Factor 6: Texto contiene numeros (episodios, temporadas)
    if (/\d+/.test(el.text)) {
      total += 3;
      factors.push({ factor: 'has-numbers', contribution: 3 });
    }

    // Factor 7: Tiene data-* attributes relevantes
    const dataKeys = Object.keys(el.attr).filter(k => k.startsWith('data-'));
    if (dataKeys.length > 0) {
      const dataScore = Math.min(dataKeys.length * 5, 15);
      total += dataScore;
      factors.push({ factor: 'has-data-attrs', contribution: dataScore });
    }

    // Factor 8: Es visible (ya filtrado, pero safety)
    total += 3;
    factors.push({ factor: 'visible', contribution: 3 });

    // Factor 9: Memoria de sesion (aprendizaje adaptativo)
    if (memory) {
      const typeBoost = memory.getTypeBoost(el.type);
      if (typeBoost > 0) {
        const memoryContribution = Math.min(typeBoost, 20);
        total += memoryContribution;
        factors.push({ factor: `memory:${el.type}`, contribution: memoryContribution });
      }

      // Factor 10: Patrones de clase CSS aprendidos
      const cls = (el.class || '').split(/\s+/)[0]!;
      if (cls) {
        const classBoost = memory.getClassBoost(cls);
        if (classBoost > 0) {
          const classContribution = Math.min(classBoost, 15);
          total += classContribution;
          factors.push({ factor: `memory-class:${cls}`, contribution: classContribution });
        }
      }

      // Factor 11: Prediccion de exito (combina tipo + clase + dominio)
      const pred = memory.predictSuccess(el.type, cls);
      if (pred.confidence > 0.3 && pred.estimatedSuccess > 0.5) {
        const predContribution = Math.round(pred.estimatedSuccess * 15);
        total += predContribution;
        factors.push({ factor: `predict:${el.type}`, contribution: predContribution });
      }
    }

    const clampedScore = Math.min(100, Math.max(0, total));
    let relevance: ContentScore['relevance'];
    if (clampedScore >= 55) relevance = 'high';
    else if (clampedScore >= 30) relevance = 'medium';
    else if (clampedScore >= 10) relevance = 'low';
    else relevance = 'skip';

    return { score: clampedScore, relevance, factors };
  }

  // ============================================================
  // CLASIFICACION DE URLs
  // ============================================================

  classifyURL(url: string, context?: string): URLClassification {
    const cached = this.urlCache.get(url);
    if (cached) return cached;

    const signals: string[] = [];
    let type: URLType = 'unknown';
    let confidence = 20;
    let isContainer = false;

    const lowerUrl = url.toLowerCase();
    const domain = this.extractDomain(url);
    const path = this.extractPath(url);
    const ext = this.extractExtension(url);

    // Señal 1: Base de conocimiento de dominios
    const known = URL_DOMAIN_KB[domain] || URL_DOMAIN_KB[this.getBaseDomain(domain)];
    if (known) {
      type = known.type;
      isContainer = known.isContainer;
      confidence = 85;
      signals.push(`kb:${domain}`);
    }

    // Señal 2: Extension de archivo
    if (/\.(mp4|mkv|avi|webm|mov|flv|wmv)($|\?)/i.test(lowerUrl)) {
      type = 'direct-video';
      confidence = Math.max(confidence, 95);
      signals.push(`ext:${ext}`);
    } else if (/\.(m3u8|mpd|hls)($|\?)/i.test(lowerUrl)) {
      type = 'stream';
      confidence = Math.max(confidence, 90);
      signals.push(`ext:${ext}`);
    } else if (/\.(zip|rar|7z|tar|gz)($|\?)/i.test(lowerUrl)) {
      type = 'download';
      confidence = Math.max(confidence, 80);
      signals.push(`ext:${ext}`);
    }

    // Señal 3: Patrones de path
    if (/\/embed\/|\/player\/|\/reproductor\/|embed\.php|player\.php|reproductor/i.test(path)) {
      if (type === 'unknown') type = 'embed';
      isContainer = true;
      confidence = Math.max(confidence, 75);
      signals.push('path:embed');
    }
    if (/\/download\/|\/descargar\/|\/d\/|\/descarga\/|download\.php|descargar\.php/i.test(path)) {
      if (type === 'unknown') type = 'download';
      confidence = Math.max(confidence, 70);
      signals.push('path:download');
    }
    if (/\/video\/|\/v\/|\/stream\/|\.mp4|\.m3u8/i.test(path)) {
      if (type === 'unknown') type = 'direct-video';
      confidence = Math.max(confidence, 65);
      signals.push('path:video');
    }
    if (/\/e\/|\/episodio\/|\/episode\/|\/capitulo\/|\/chapter\/|\/ver\//i.test(path)) {
      if (type === 'unknown') type = 'navigation';
      isContainer = true;
      confidence = Math.max(confidence, 60);
      signals.push('path:episode');
    }

    // Señal 4: Contexto (texto del boton/link que llevo a esta URL)
    if (context) {
      const ctx = context.toLowerCase();
      if (/server|servidor|mirror|opcion/i.test(ctx)) {
        if (type === 'unknown') type = 'embed';
        isContainer = true;
        confidence = Math.max(confidence, 65);
        signals.push('ctx:server');
      }
      if (/download|descarg/i.test(ctx)) {
        if (type === 'unknown') type = 'download';
        confidence = Math.max(confidence, 65);
        signals.push('ctx:download');
      }
      if (/play|reproduc|ver|watch/i.test(ctx)) {
        if (type === 'unknown') type = 'embed';
        isContainer = true;
        confidence = Math.max(confidence, 60);
        signals.push('ctx:play');
      }
      if (/episodio|episode|capitulo|chapter/i.test(ctx)) {
        if (type === 'unknown') type = 'navigation';
        confidence = Math.max(confidence, 55);
        signals.push('ctx:episode');
      }
      if (/idioma|language|lang/i.test(ctx)) {
        confidence = Math.max(confidence, 50);
        signals.push('ctx:language');
      }
    }

    // Señal 5: Query params sospechosos
    if (/[?&](token|auth|key|api|session|sid)=/i.test(lowerUrl)) {
      isContainer = false;
      signals.push('query:auth');
    }
    if (/[?&](redirect|url|goto|return|next)=/i.test(lowerUrl)) {
      isContainer = true;
      signals.push('query:redirect');
    }

    // Señal 6: Dominios de tracking/publicidad
    if (/analytics|track|pixel|beacon|stats|metric|collect/i.test(domain)) {
      type = 'tracking';
      confidence = 80;
      signals.push('domain:tracking');
    }

    const result: URLClassification = {
      type,
      confidence: Math.min(100, confidence),
      isContainer,
      signals,
    };

    this.urlCache.set(url, result);
    return result;
  }

  // ============================================================
  // DETECCION DE ZONAS DE PAGINA
  // ============================================================

  detectPageZone(el: RawElement): PageZone {
    const combined = this.buildSignalText(el);
    const fullText = combined.text + ' ' + combined.classes + ' ' + combined.attrs;

    let bestZone: PageZoneType = 'unknown';
    let bestScore = 0;

    for (const [zone, patterns] of Object.entries(ZONE_PATTERNS)) {
      if (zone === 'unknown') continue;
      let score = 0;

      for (const re of patterns.classPatterns) {
        if (re.test(combined.classes)) score += 20;
      }
      for (const re of patterns.tagPatterns) {
        if (re.test(el.tag)) score += 15;
      }
      for (const re of patterns.attrPatterns) {
        if (re.test(combined.attrs)) score += 10;
      }

      if (score > bestScore) {
        bestScore = score;
        bestZone = zone as PageZoneType;
      }
    }

    const confidence = Math.min(100, bestScore + 10);

    // Heuristica: si el elemento tiene muchos links de navegacion, es nav
    if (bestZone === 'unknown' && el.type === 'container') {
      if (/nav/i.test(fullText)) {
        return { zone: 'nav', confidence: 60 };
      }
    }

    return { zone: bestZone, confidence };
  }

  // ============================================================
  // PRIORIZACION DE ELEMENTOS PARA EXPLORACION
  // ============================================================

  prioritizeElements(elements: RawElement[], memory?: SessionMemory): RawElement[] {
    const scored = elements.map(el => ({
      el,
      score: this.scoreContentRelevance(el, memory),
      intent: this.classifyElementIntent(el),
      zone: this.detectPageZone(el),
    }));

    // Ordenar por score, luego por profundidad (DOM superior primero)
    scored.sort((a, b) => {
      // Los que son "skip" al fondo
      if (a.score.relevance === 'skip' && b.score.relevance !== 'skip') return 1;
      if (b.score.relevance === 'skip' && a.score.relevance !== 'skip') return -1;
      // Por score descendente
      if (a.score.score !== b.score.score) return b.score.score - a.score.score;
      // Por profundidad ascendente (mas arriba primero)
      return a.el.depth - b.el.depth;
    });

    // Marcar zonas de baja prioridad
    return scored
      .filter(s => {
        // Filtrar elementos en header/footer con baja confianza de contenido
        if (s.zone.zone === 'footer' && s.score.relevance !== 'high') return false;
        if (s.zone.zone === 'header' && s.score.relevance === 'low') return false;
        if (s.intent.action === 'ad' || s.intent.action === 'social' || s.intent.action === 'login') return false;
        return true;
      })
      .map(s => s.el);
  }

  // ============================================================
  // ANALISIS COMPLETO DE PAGINA
  // ============================================================

  analyze(elements: RawElement[]): AnalysisReport {
    const elementIntents = new Map<string, ElementIntent>();
    const contentScores = new Map<string, ContentScore>();
    const pageZones = new Map<string, PageZone>();
    const urlClassifications = new Map<string, URLClassification>();

    const serverElements: RawElement[] = [];
    const videoElements: RawElement[] = [];
    const downloadElements: RawElement[] = [];
    const navigationElements: RawElement[] = [];
    let highRelevanceCount = 0;
    let contentElementCount = 0;

    for (const el of elements) {
      const intent = this.classifyElementIntent(el);
      const score = this.scoreContentRelevance(el);
      const zone = this.detectPageZone(el);
      const urls = this.extractElementUrls(el);

      elementIntents.set(el.selector, intent);
      contentScores.set(el.selector, score);
      pageZones.set(el.selector, zone);

      for (const url of urls) {
        if (!urlClassifications.has(url)) {
          urlClassifications.set(url, this.classifyURL(url, el.text));
        }
      }

      if (score.relevance === 'high') highRelevanceCount++;
      if (score.relevance !== 'skip') contentElementCount++;

      switch (intent.action) {
        case 'switch-server': serverElements.push(el); break;
        case 'play-video': videoElements.push(el); break;
        case 'download': downloadElements.push(el); break;
        case 'navigate-episode': navigationElements.push(el); break;
      }
    }

    const zones = [...pageZones.values()];
    const zoneCounts = new Map<PageZoneType, number>();
    for (const z of zones) {
      zoneCounts.set(z.zone, (zoneCounts.get(z.zone) || 0) + 1);
    }
    let dominantZone: PageZoneType = 'unknown';
    let maxZoneCount = 0;
    for (const [zone, count] of zoneCounts) {
      if (count > maxZoneCount) {
        maxZoneCount = count;
        dominantZone = zone;
      }
    }

    return {
      elementIntents,
      contentScores,
      urlClassifications,
      pageZones,
      summary: {
        dominantZone,
        contentElementCount,
        highRelevanceCount,
        serverElements,
        videoElements,
        downloadElements,
        navigationElements,
      },
    };
  }

  // ============================================================
  // INFERIR NOMBRE DE SERVIDOR (mejorado)
  // ============================================================

  inferServerName(domain: string): string {
    const knownServers: Record<string, string> = {
      'streamtape.com': 'StreamTape',
      'streamtape.net': 'StreamTape',
      'yourupload.com': 'YourUpload',
      'mega.nz': 'MEGA',
      'mega.co.nz': 'MEGA',
      'ok.ru': 'OK.ru',
      'uqload.com': 'Uqload',
      'uqload.co': 'Uqload',
      'hqq.tv': 'HQQ',
      'hqq.watch': 'HQQ',
      'bysekoze.com': 'BySekoze',
      'swhoi.com': 'SWHOI',
      'netu.tv': 'Netu',
      'netu.io': 'Netu',
      'filemoon.sx': 'Filemoon',
      'filemoon.to': 'Filemoon',
      'streamwish.to': 'StreamWish',
      'embedwish.com': 'EmbedWish',
      'cdnwish.com': 'CDNWish',
      'hgcloud.to': 'HGCloud',
      'nyuu.streamhj.top': 'Nyuu',
      'multiplayer.streamhj.top': 'MultiPlayer',
      'descargas.streamhj.top': 'Descargas',
      'descargas.henaojara.com': 'Descargas HenaoJara',
      'animejara.com': 'AnimeJara',
      'henaojara.com': 'HenaoJara',
      'jara.com': 'Jara',
      'youtube.com': 'YouTube',
      'youtu.be': 'YouTube',
      'dailymotion.com': 'Dailymotion',
      'vimeo.com': 'Vimeo',
      'drive.google.com': 'Google Drive',
      'dropbox.com': 'Dropbox',
      'mediafire.com': 'MediaFire',
      'zippyshare.com': 'ZippyShare',
      '1fichier.com': '1Fichier',
      'sendvid.com': 'SendVid',
      'vidlox.me': 'VidLox',
      'vidoza.net': 'Vidoza',
      'vidfast.co': 'VidFast',
      'upstream.to': 'UpStream',
      'burstcloud.cc': 'BurstCloud',
      'burstcloud.to': 'BurstCloud',
      'gounlimited.to': 'GoUnlimited',
      'mixdrop.co': 'MixDrop',
      'mixdrop.ag': 'MixDrop',
      'fembed.com': 'Fembed',
      'fembed.net': 'Fembed',
      'feurl.com': 'Fembed',
      'playhydrax.com': 'Hydrax',
      'hydrax.net': 'Hydrax',
      'cloudvideo.tv': 'CloudVideo',
      'jawcloud.co': 'JawCloud',
      'sbembed.com': 'SBEmbed',
      'sbembed1.com': 'SBEmbed',
      'sbplay.org': 'SBPlay',
      'sbplay1.com': 'SBPlay',
      'sbplay2.com': 'SBPlay',
      'sbplay3.com': 'SBPlay',
      'mystream.to': 'MyStream',
      'mp4upload.com': 'MP4Upload',
      'dood.so': 'DoodStream',
      'dood.ws': 'DoodStream',
      'dood.wf': 'DoodStream',
      'dood.re': 'DoodStream',
      'dood.sh': 'DoodStream',
      'dood.la': 'DoodStream',
      'dood.to': 'DoodStream',
      'dood.pm': 'DoodStream',
      'voe.sx': 'VOE',
      'voe.su': 'VOE',
      'vidhide.com': 'VidHide',
      'vidpro.com': 'VidHide',
      'vidguard.net': 'VidHide',
      'vidmoly.to': 'VidMoly',
      'vidmoly.net': 'VidMoly',
      'mixdrop.vc': 'MixDrop',
      'mixdrop.to': 'MixDrop',
      'mixdrop.ch': 'MixDrop',
      'mixdrop.gl': 'MixDrop',
      'uptostream.to': 'UpStream',
      'uptobox.com': 'UpToBox',
      'vidozahd.com': 'Vidoza',
      'vidlox.tv': 'VidLox',
      'vidlox.net': 'VidLox',
      'streamlare.com': 'StreamLare',
      'wolfmax4k.com': 'WolfMax4K',
      'vudeo.net': 'Vudeo',
      'sfastwish.com': 'StreamWish',
      'flaswish.com': 'StreamWish',
      'tapecontent.net': 'TapeContent',
      'stpete.net': 'StreamTape',
      'jaw.cloud': 'JawCloud',
      'vidcloud.tv': 'CloudVideo',
    };

    if (knownServers[domain]) return knownServers[domain];

    const parts = domain.replace(/^www\.|^embed\.|^player\.|^cdn\.|^api\.|^static\./i, '').split('.');
    const main = parts.length > 1 ? parts[parts.length - 2]! : parts[0]!;

    // Capitalizar primera letra
    return main.charAt(0).toUpperCase() + main.slice(1).slice(0, 24);
  }

  // ============================================================
  // UTILIDADES
  // ============================================================

  private buildSignalText(el: RawElement): { text: string; classes: string; attrs: string } {
    const text = el.text.toLowerCase();
    const classes = (el.class || '').toLowerCase();
    const attrs = Object.values(el.attr).join(' ').toLowerCase() +
      ' ' + Object.keys(el.attr).join(' ').toLowerCase();
    return { text, classes, attrs };
  }

  private extractElementUrls(el: RawElement): string[] {
    const urls: string[] = [];
    const src = el.attr.src || el.attr.href || '';
    if (src && !src.startsWith('#') && !src.startsWith('javascript:') && src !== 'about:blank') {
      urls.push(src);
    }
    for (const key of Object.keys(el.attr)) {
      if (key.startsWith('data-') && /url|src|href|link|video|embed/i.test(key)) {
        const val = el.attr[key];
        if (val && val.startsWith('http')) urls.push(val);
      }
    }
    const onclick = el.attr.onclick || '';
    const matches = onclick.match(/https?:\/\/[^'")\s]+/g);
    if (matches) urls.push(...matches);
    return urls;
  }

  extractDomain(url: string): string {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      return host;
    } catch {
      return url.replace(/https?:\/\//, '').split(/[/?#]/)[0] || url.slice(0, 40);
    }
  }

  getBaseDomain(domain: string): string {
    return domain.replace(/^(?:ww[0-9]+|vww|www[0-9]*)\./, '');
  }

  private extractPath(url: string): string {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }

  private extractExtension(url: string): string {
    try {
      const path = new URL(url).pathname;
      const match = path.match(/\.([a-z0-9]{2,5})($|\?)/i);
      return match ? match[1]! : '';
    } catch {
      return '';
    }
  }

  clearCache(): void {
    this.urlCache.clear();
    this.intentCache.clear();
  }
  // ============================================================
  // INFERENCIA DE PATRONES DE URL (nuevo)
  // ============================================================

  inferCandidateUrls(knownUrls: string[], searchTerm: string, baseUrl: string): string[] {
    const candidates: { url: string; confidence: number; pattern: string }[] = [];
    const term = searchTerm.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (term.length < 2) return [];

    // Extraer patrones de path de las URLs conocidas
    const pathPatterns = new Map<string, number>();
    for (const url of knownUrls) {
      try {
        const u = new URL(url);
        const path = u.pathname;
        // Detectar patrones: /anime/{slug}/, /ver/{slug}, /episode/{slug}-{num}/
        const segments = path.split('/').filter(Boolean);

        for (let i = 0; i < segments.length; i++) {
          // Reemplazar segmentos variables con {var}
          const template = segments.map((s, idx) => {
            if (idx === i) return '{slug}';
            // Detectar IDs numericos
            if (/^\d+$/.test(s) || /\d+x\d+/.test(s)) return '{num}';
            return s;
          });
          const pattern = '/' + template.join('/') + '/';
          pathPatterns.set(pattern, (pathPatterns.get(pattern) || 0) + 1);
        }
      } catch { /* ignore */ }
    }

    // Ordenar patrones por frecuencia
    const sortedPatterns = [...pathPatterns.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1]! - a[1]!);

    // Generar candidatos para cada patron
    for (const [pattern, count] of sortedPatterns) {
      const candidatePath = pattern.replace('{slug}', term).replace(/\{num\}/g, '');
      try {
        const base = new URL(baseUrl);
        const candidateUrl = base.origin + candidatePath;
        if (!knownUrls.includes(candidateUrl)) {
          candidates.push({
            url: candidateUrl,
            confidence: Math.min(100, count * 25),
            pattern,
          });
        }
      } catch { /* ignore */ }
    }

    // También probar slugs alternativos (con guiones, sin guiones, etc.)
    const altSlugs = [
      term,
      term.replace(/-/g, ''),
      term.replace(/-/g, ' '),
      term + '-shippuden',
      term + '-tv',
    ];

    for (const [pattern] of sortedPatterns.slice(0, 2)) {
      for (const slug of altSlugs) {
        const altPath = pattern.replace('{slug}', slug.replace(/\s+/g, '-')).replace(/\{num\}/g, '');
        try {
          const base = new URL(baseUrl);
          const candidateUrl = base.origin + altPath;
          if (!candidates.find(c => c.url === candidateUrl)) {
            candidates.push({ url: candidateUrl, confidence: 20, pattern: pattern + ' (alt)' });
          }
        } catch { /* ignore */ }
      }
    }

    return candidates
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 4)
      .map(c => c.url);
  }
}

// Instancia singleton para reuso
let defaultInstance: SmartAnalyzer | null = null;

export function getSmartAnalyzer(): SmartAnalyzer {
  if (!defaultInstance) {
    defaultInstance = new SmartAnalyzer();
  }
  return defaultInstance;
}

export function resetSmartAnalyzer(): void {
  defaultInstance?.clearCache();
  defaultInstance = null;
}
