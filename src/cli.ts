import { Command } from 'commander';
import { ScraperEngine } from './ScraperEngine';
import { getLogger } from './utils/logger';
import { getProviderRegistry } from './analysis/ProviderRegistry';
import type { ScraperConfig, StrategyName, LogLevel, ProviderConfig } from './types';

const program = new Command();

program
  .name('argos')
  .description('Argos — Motor de escrapeo inteligente v3.4')
  .version('3.4.0');

program
  .command('scrape <url>')
  .description('Escrpea una URL')
  .option('-s, --strategies <list>', 'Estrategias (csv: cheerio,iframe,puppeteer)', 'cheerio,iframe,puppeteer')
  .option('--no-headless', 'Mostrar navegador')
  .option('--no-stealth', 'Desactivar stealth')
  .option('--no-block', 'Desactivar bloqueo de recursos')
  .option('-r, --retries <n>', 'Reintentos', '3')
  .option('-t, --timeout <ms>', 'Timeout por pagina', '30000')
  .option('-p, --proxy <url>', 'Proxy URL')
  .option('--screenshot', 'Tomar screenshot')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (url, options) => {
    const engine = new ScraperEngine({
      strategies: options.strategies.split(',').map((s: string) => s.trim()) as StrategyName[],
      headless: options.headless,
      stealth: options.stealth,
      blockResources: options.block,
      retry: { maxRetries: parseInt(options.retries), delayMs: 1000 },
      timeouts: { page: parseInt(options.timeout), global: 120000 },
      proxy: { list: options.proxy ? [options.proxy] : [], enabled: !!options.proxy },
      screenshots: { enabled: options.screenshot, dir: './screenshots' },
      logLevel: options.logLevel as LogLevel,
    });

    try {
      await engine.initialize();
      const result = await engine.extract({ url });
      if (result.length === 0) {
        getLogger().warn('No se encontraron datos');
      }
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await engine.shutdown();
    }
  });

program
  .command('autonomous <url>')
  .description('Escrapeo autonomo inteligente (zero selectores fijos)')
  .option('-q, --query <term>', 'Termino de busqueda si hay campo search')
  .option('-t, --terms <list>', 'Multiples terminos de busqueda (csv) para fallback progresivo')
  .option('-g, --goal <type>', 'Tipo de contenido: video, image, download, manga, document, auto', 'auto')
  .option('-m, --max-requests <n>', 'Max requests por sesion', '50')
  .option('-d, --deadline <ms>', 'Deadline en ms para resultados parciales', '45000')
  .option('--no-headless', 'Mostrar navegador')
  .option('--debug', 'Activar visor de depuracion (screenshots + HTML)')
  .option('-p, --proxy <url>', 'Proxy URL')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (url, options) => {
    const engine = new ScraperEngine({
      headless: options.headless,
      proxy: { list: options.proxy ? [options.proxy] : [], enabled: !!options.proxy },
      logLevel: options.logLevel as LogLevel,
      streamDeadlineMs: parseInt(options.deadline),
    });

    try {
      await engine.initialize();
      const result = await engine.autonomousScrape(url, {
        searchTerm: options.query,
        searchTerms: options.terms ? options.terms.split(',').map((s: string) => s.trim()) : undefined,
        contentGoal: options.goal,
        maxRequests: parseInt(options.maxRequests),
        debug: options.debug,
        deadlineMs: parseInt(options.deadline),
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await engine.shutdown();
    }
  });

program
  .command('batch <file>')
  .description('Escrpea multiples URLs desde un archivo JSON')
  .option('-c, --concurrency <n>', 'Concurrencia maxima', '3')
  .option('-s, --strategies <list>', 'Estrategias', 'cheerio,iframe,puppeteer')
  .option('--no-headless', 'Mostrar navegador')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (file, options) => {
    const { readFileSync } = await import('node:fs');
    const urls: string[] = JSON.parse(readFileSync(file, 'utf-8'));

    const engine = new ScraperEngine({
      concurrency: { max: parseInt(options.concurrency) },
      strategies: options.strategies.split(',').map((s: string) => s.trim()) as StrategyName[],
      headless: options.headless,
      logLevel: options.logLevel as LogLevel,
    });

    try {
      await engine.initialize();
      const results = await engine.extractMultiple(urls.map((u: string) => ({ url: u })));
      console.log(JSON.stringify(results, null, 2));
    } finally {
      await engine.shutdown();
    }
  });

program
  .command('quick <url>')
  .description('Escrapeo rapido (single-page, ~8-30s, sin recursion profunda)')
  .option('-g, --goal <type>', 'Tipo de contenido', 'auto')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (url, options) => {
    const engine = new ScraperEngine({ logLevel: options.logLevel as LogLevel });
    try {
      await engine.initialize();
      const result = await engine.quickScrape(url, { contentGoal: options.goal });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await engine.shutdown();
    }
  });

program
  .command('static <url>')
  .description('Analisis sin navegador (fetch + cheerio, ~15MB RAM, no requiere Chrome)')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (url, options) => {
    const engine = new ScraperEngine({ logLevel: options.logLevel as LogLevel });
    const result = await engine.staticAnalyze(url);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('resolve-embed <url>')
  .description('Resuelve un embed URL a su stream directo (m3u8/mp4)')
  .option('-r, --referer <url>', 'Referer header')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (url, options) => {
    const engine = new ScraperEngine({ logLevel: options.logLevel as LogLevel });
    try {
      await engine.initialize();
      const result = await engine.resolveEmbed(url, options.referer);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await engine.shutdown();
    }
  });

program
  .command('health')
  .description('Muestra el estado de salud de todos los providers y circuitos')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (options) => {
    const engine = new ScraperEngine({ logLevel: options.logLevel as LogLevel });
    try {
      await engine.initialize();
      const report = engine.getHealthReport();
      const circuits = engine.getCircuitStates();
      console.log(JSON.stringify({ providers: report, circuits }, null, 2));
    } finally {
      await engine.shutdown();
    }
  });

program
  .command('providers')
  .description('Lista todos los providers registrados')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (options) => {
    const engine = new ScraperEngine({ logLevel: options.logLevel as LogLevel });
    const providers = engine.getProviders();
    console.log(JSON.stringify(providers, null, 2));
  });

program
  .command('register-provider <file>')
  .description('Registra un provider desde un archivo JSON')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (file, options) => {
    const { readFileSync } = await import('node:fs');
    const config: ProviderConfig = JSON.parse(readFileSync(file, 'utf-8'));
    const engine = new ScraperEngine({ logLevel: options.logLevel as LogLevel });
    engine.registerProvider(config);
    console.log(JSON.stringify({ registered: config.name, count: engine.getProviders().length }));
  });

program
  .command('serve <url>')
  .description('Escrapeo con streaming WebSocket en tiempo real')
  .option('-p, --port <n>', 'Puerto del servidor WebSocket', '0')
  .option('-q, --query <term>', 'Termino de busqueda')
  .option('-g, --goal <type>', 'Tipo de contenido', 'auto')
  .option('--no-headless', 'Mostrar navegador')
  .option('--log-level <level>', 'Log level', 'info')
  .action(async (url, options) => {
    const engine = new ScraperEngine({
      headless: options.headless,
      logLevel: options.logLevel as LogLevel,
    });
    try {
      await engine.initialize();
      const { port, result } = await engine.streamScrape(url, {
        port: parseInt(options.port),
        searchTerm: options.query,
        contentGoal: options.goal,
      });
      console.log(`WebSocket server: ws://localhost:${port}`);
      console.log('Waiting for scrape to complete...');
      const data = await result;
      console.log(JSON.stringify(data, null, 2));
    } finally {
      await engine.shutdown();
    }
  });

program
  .command('stats')
  .description('Muestra estadisticas del pool de browsers y memoria')
  .action(async () => {
    const engine = new ScraperEngine();
    try {
      await engine.initialize();
      console.log(JSON.stringify(engine.getStats(), null, 2));
    } finally {
      await engine.shutdown();
    }
  });

program.parse();
