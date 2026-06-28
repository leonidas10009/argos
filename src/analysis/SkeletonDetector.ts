import { getLogger } from '../utils/logger';

interface PageFingerprint {
  url: string;
  selectors: Set<string>;
  texts: Set<string>;
  classes: Set<string>;
}

export class SkeletonDetector {
  private fingerprints: Map<string, PageFingerprint[]> = new Map();
  private skeletonSelectors: Map<string, Set<string>> = new Map();
  private skeletonTexts: Map<string, Set<string>> = new Map();

  addPageFingerprint(domain: string, url: string, selectors: string[], texts: string[], classes: string[]): void {
    if (!this.fingerprints.has(domain)) {
      this.fingerprints.set(domain, []);
    }

    const fp: PageFingerprint = {
      url,
      selectors: new Set(selectors),
      texts: new Set(texts),
      classes: new Set(classes),
    };

    const domainFps = this.fingerprints.get(domain)!;
    domainFps.push(fp);

    // Si tenemos 2+ paginas del mismo dominio, comparar para encontrar esqueleto
    if (domainFps.length >= 2) {
      this.detectSkeleton(domain, domainFps);
    }
  }

  isSkeleton(domain: string, selector: string, text: string): boolean {
    const domainSelectors = this.skeletonSelectors.get(domain);
    const domainTexts = this.skeletonTexts.get(domain);

    // El selector aparece como esqueleto
    if (domainSelectors?.has(selector)) return true;

    // El texto es repetido en todas las paginas (ej: "Inicia Sesión", "Login")
    if (domainTexts?.has(text.toLowerCase().trim())) return true;

    // Heuristicas universales (no necesitan comparacion)
    if (this.isUniversalSkeleton(selector, text)) return true;

    return false;
  }

  private detectSkeleton(domain: string, fps: PageFingerprint[]): void {
    if (fps.length < 2) return;

    const selectors = new Set<string>();
    const texts = new Set<string>();

    // Interseccion: elementos que aparecen en TODAS las paginas
    const first = fps[0]!;
    const second = fps[1]!;

    for (const sel of first.selectors) {
      if (second.selectors.has(sel) && fps.every(f => f.selectors.has(sel))) {
        selectors.add(sel);
      }
    }

    for (const text of first.texts) {
      if (second.texts.has(text) && fps.every(f => f.texts.has(text))) {
        // Solo textos cortos (menus, botones, no contenido)
        if (text.length >= 2 && text.length <= 40) {
          texts.add(text);
        }
      }
    }

    if (selectors.size > 0 || texts.size > 0) {
      this.skeletonSelectors.set(domain, selectors);
      this.skeletonTexts.set(domain, texts);
      getLogger().info({
        domain,
        skeletonSelectors: selectors.size,
        skeletonTexts: texts.size,
        samples: [...texts].slice(0, 8).join(', '),
      }, 'Skeleton detected on domain');
    }
  }

  private isUniversalSkeleton(selector: string, text: string): boolean {
    const sel = selector.toLowerCase();
    const txt = text.toLowerCase().trim();

    // Patrones de auth
    if (/login|sign.?in|sign.?up|register|regist|iniciar\s*sesi|cerrar\s*sesi|logout|cuenta|account|perfil|profile|contrase|password|olvid|forgot/i.test(txt)) {
      return true;
    }

    // Patrones de navegacion universal
    if (/nav|menu|header|footer|sidebar|breadcrumb/i.test(sel)) {
      return true;
    }

    // Links de sociales
    if (/discord|telegram|facebook|twitter|instagram|whatsapp|reddit|tiktok|youtube/i.test(txt)) {
      return true;
    }

    // Botones de cookies/privacidad
    if (/cookie|privac|dmca|terms|tos|condiciones|aceptar|rechazar/i.test(txt)) {
      return true;
    }

    // Idioma/moneda (selectores globales)
    if (/language|idioma|lang|currency|moneda|region|pais/i.test(sel + txt)) {
      return true;
    }

    // Elementos de footer
    if (sel.startsWith('footer') || sel.includes('.footer')) {
      return true;
    }

    return false;
  }

  clear(): void {
    this.fingerprints.clear();
    this.skeletonSelectors.clear();
    this.skeletonTexts.clear();
  }
}
