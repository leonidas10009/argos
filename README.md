# Argos

> Sistema de escrapeo inteligente híbrido — Cheerio → Iframe → Puppeteer, con pool de browsers, stealth, proxy rotativo, memoria bayesiana, y pipeline multi-provider.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)
[![Version](https://img.shields.io/badge/version-3.5.0-orange)](package.json)
[![Tests](https://img.shields.io/badge/tests-94%20passing-brightgreen)](tests/)

---

## Instalación

```bash
npm install
npm run build
```

## Uso rápido

### CLI

```bash
# Escrapeo tradicional
npx tsx src/cli.ts scrape "https://..."

# Autónomo inteligente (depth-first, zero selectores fijos)
npx tsx src/cli.ts autonomous "https://..." -q "naruto" -g video

# Rápido (fast path, ~8-30s, single-page)
npx tsx src/cli.ts quick "https://..."

# Sin navegador (~15MB RAM)
npx tsx src/cli.ts static "https://..."

# Resolver embeds → URL directa
npx tsx src/cli.ts resolve-embed "https://streamwish.to/e/abc123"

# Batch + health
npx tsx src/cli.ts batch urls.json -c 5
npx tsx src/cli.ts health
```

### API

```ts
import { ScraperEngine } from 'argos';

const engine = new ScraperEngine({ streamDeadlineMs: 30_000 });
await engine.initialize();

// Autónomo (depth-first recursive)
const result = await engine.autonomousScrape('https://...', {
  searchTerm: 'naruto',
  searchTerms: ['naruto shippuden', 'naruto clasico'],
  contentGoal: 'video',
  deadlineMs: 30_000,
});
// result.streams → StreamInfo[] (prioridad, deduplicado)
// result.serverCatalog → enriquecido con quality, language, directUrl
// result.partial → true si el deadline expiró

// Rápido (single page, ~8-30s)
const quick = await engine.quickScrape('https://...');

// Resolver embeds → m3u8/mp4 directo
const embed = await engine.resolveEmbed('https://streamwish.to/e/abc123');
// → { directUrl: 'https://cdn.../video.m3u8', serverName: 'StreamWish' }

// Health & circuitos
const health = engine.getHealthSummary();
const circuits = engine.getCircuitStates();

// Providers
const providers = engine.getProviders();
engine.registerProvider({ name: 'mi-site', baseUrl: '...', ... });

await engine.shutdown();
```

---

## Arquitectura

```
src/
├── ScraperEngine.ts          # API pública: scrape, autonomousScrape, quickScrape,
│                               resolveEmbed, getHealthSummary, executeProvider...
├── types/index.ts            # 30 interfaces tipadas
│
├── strategies/               # Cascade Cheerio → Iframe → Puppeteer
├── browser/                  # BrowserPool, launcher (auto-detect Chrome), ResourceBlocker
├── interactions/             # PageInteractions: click, hover, scroll, pagination
│
├── engines/                  # Routing + pipeline
│   ├── Router.ts             # Multi-engine con orden bayesiano adaptativo
│   └── StreamPipeline.ts     # Chunked execution, Promise.race, circuit breaker, dedup
│
├── analysis/                 # Core inteligente (21 módulos)
│   ├── AutonomousScraper.ts  # Depth-first + quickInvestigate, ContentGoal, progressive search
│   ├── SmartAnalyzer.ts      # 118 dominios en KB, classifyElementIntent (13 acciones)
│   ├── SessionMemory.ts      # Aprendizaje bayesiano + persistencia cross-sesión
│   ├── ProviderMemory.ts     # Aprendizaje por provider/engine/fase + cross-feed
│   ├── HealthMonitor.ts      # Scoring bayesiano (s+1)/(t+2), provider scoring
│   ├── EmbedResolver.ts      # 15+ dominios → URL directa (m3u8/mp4)
│   ├── CircuitBreaker.ts     # closed/open/half-open, 5 fallos → 5min
│   ├── MemoryWatchdog.ts     # Heap 70% → clear caches + prune + GC
│   ├── StreamNormalizer.ts   # Quality (4K→CAM), language (8 idiomas), priority
│   ├── ProviderRegistry.ts   # 4 providers built-in + API register/get/import
│   ├── LazyImageResolver.ts  # Extracción lazy images (cover_url, data-src, bg)
│   ├── RedirectChainFollower.ts  # Cadenas afiliadas + Cloudflare detect
│   ├── PaginatedCategoryScraper.ts # Auto-detect paginación + fetch concurrente
│   ├── DynamicPageHandler.ts # SPA, infinite scroll, shadow DOM, network intercept
│   ├── StaticScraper.ts      # Fetch + cheerio (~15MB RAM)
│   ├── HeuristicAnalyzer.ts  # 7 heurísticas DOM
│   ├── SkeletonDetector.ts   # Cross-page dedup
│   ├── PageTypeClassifier.ts # listing/detail/content/search
│   └── ...
│
├── utils/                    # Logger, retry, screenshot, Anubis PoW solver
├── proxy/                    # ProxyRotator con round-robin + failure tracking
└── extractors/               # ServerListExtractor multi-idioma
```

---

## Features

### Inteligencia

| Feature | Descripción |
|---------|-------------|
| **Exploración depth-first** | Recursivo, con set diffing de URLs y cache de modelo por página |
| **Zero selectores fijos** | Todo por heurística semántica + inferencia de patrones |
| **Memoria bayesiana** | Persistencia cross-sesión (`.scraper-memory.json`), predicciones, URL chains |
| **ContentGoal** | Auto-detecta `video\|manga\|image\|download\|document` y adapta estrategia |
| **Skeleton detection** | Detecta esqueleto del sitio (menus, footer) y evita re-explorarlo |
| **Page type classifier** | Clasifica páginas en `listing\|detail\|content\|search` |

### Resolución de contenido

| Feature | Descripción |
|---------|-------------|
| **Embed → URL directa** | 15+ dominios: streamwish, filemoon, doodstream, mixdrop, voe, streamtape... |
| **Stream normalization** | Quality (4K–CAM), language (ES/EN/JA/KO...), server name, priority scoring |
| **Lazy image resolver** | `cover_url`, `data-src`, `data-original`, `srcset`, background images |
| **Redirect chain follower** | Sigue cadenas afiliadas (ouo.io, linkvertise) + detecta Cloudflare |

### Producción

| Feature | Descripción |
|---------|-------------|
| **Circuit breaker** | 5 fallos consecutivos → 5min abierto, half-open probe |
| **Memory watchdog** | Heap monitoring, limpieza automática al 70%, force restart al 90% |
| **Stream pipeline** | Chunked execution (8 providers), Promise.race timeouts, global deadline |
| **Provider memory** | Aprendizaje bayesiano por provider/engine/fase, orden adaptativo |
| **Health monitor** | Scoring bayesiano `(s+1)/(t+2)`, provider scoring, summary API |
| **Anubis PoW solver** | Bypass anti-bot challenge SHA-256 zero-bit (async + sync) |

### Escalabilidad

| Feature | Descripción |
|---------|-------------|
| **Provider registry** | Definiciones JSON declarativas, API `register/get/import` |
| **Paginated scraper** | Auto-detecta `_N.html`, `?page=N`, `/page/N/` + fetch concurrente |
| **Progressive search** | Array `searchTerms[]` con fallback automático (título completo → parcial) |
| **Deadline + partial** | Resultados parciales si se excede el deadline configurable |

---

## Knowledge bases

| Base | Entradas | Descripción |
|------|----------|-------------|
| `URL_DOMAIN_KB` | 118 | Clasificación de dominios: embed, download, CDN, social, tracking, anime |
| `KNOWN_SERVERS` | 95+ | Mapeo dominio → nombre legible (streamtape→StreamTape, etc.) |
| `AFFILIATE_REDIRECT` | 14 | Dominios de redirección afiliados conocidos |
| Providers built-in | 4 | animejara, tioanime, animeflv, jkanime |

---

## Configuración (.env)

```env
# Browser Pool
BROWSER_POOL_MIN=1
BROWSER_POOL_MAX=3

# Estrategias
STRATEGIES=cheerio,iframe,puppeteer
HEADLESS=true
STEALTH=true
BLOCK_RESOURCES=true

# Timeouts
PAGE_TIMEOUT_MS=30000
STREAM_DEADLINE_MS=45000

# Circuit Breaker
CB_FAILURE_THRESHOLD=5
CB_RESET_TIMEOUT_MS=300000

# Memory Watchdog
MW_ENABLED=true
MW_WARNING_PERCENT=70
MW_CRITICAL_PERCENT=90

# Logging
LOG_LEVEL=info
```

---

## Stack

| Tecnología | Uso |
|-----------|-----|
| TypeScript 5.5 | Lenguaje principal, strict mode |
| Puppeteer + Stealth | Navegador headless anti-detección |
| Cheerio | Parsing HTML estático (~15MB RAM) |
| @sparticuz/chromium | Chromium ligero para entornos cloud |
| Pino | Logging estructurado |
| Commander | CLI |
| dotenv | Configuración por variables de entorno |

---

## Quick Start (ejemplo completo)

```bash
git clone https://github.com/leonidas10009/argos.git
cd argos
npm install
npm run build

# Escrapeo autónomo de un sitio de anime
npx tsx src/cli.ts autonomous "https://animejara.com" -q "naruto" -g video

# Mismo resultado vía API
npx tsx -e "
const { ScraperEngine } = require('./dist/index.js');
(async () => {
  const engine = new ScraperEngine({ headless: true, streamDeadlineMs: 30_000 });
  await engine.initialize();
  const result = await engine.autonomousScrape('https://animejara.com', {
    searchTerm: 'naruto', contentGoal: 'video', maxRequests: 30
  });
  console.log('Servidores:', result.serverCatalog.length);
  console.log('Streams:', result.streams.slice(0, 3).map(s => s.serverName + ' ' + s.quality));
  await engine.shutdown();
})();
"

# Ejecutar tests
npm test
```

---

## Solución de problemas

| Problema | Solución |
|----------|----------|
| `Error: Engine not initialized` | Llama `await engine.initialize()` antes de cualquier operación |
| Chrome no encontrado | Instala Chrome o configura `CHROME_PATH` en `.env` |
| `CircuitOpenError` | El sitio fue bloqueado tras 5 fallos. Espera 5 min o usa `engine.getCircuitStates()` |
| El scrapeo no encuentra servidores | Prueba con `-g auto` para auto-detectar el tipo de contenido |
| `npm run build` falla | Verifica Node ≥18: `node -v` |
| Quiero scrapear sin navegador | Usa `staticAnalyze()` o CLI `static` — ~15MB RAM, sin Chrome |

---

## Licencia

MIT © [leonidas10009](https://github.com/leonidas10009)
