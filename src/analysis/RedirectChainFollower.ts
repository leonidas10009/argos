import type { Page } from 'puppeteer';
import { getLogger } from '../utils/logger';

export interface RedirectHop {
  order: number;
  url: string;
  statusCode: number;
  domain: string;
  isAffiliate: boolean;
  durationMs: number;
}

export interface RedirectChainResult {
  initialUrl: string;
  finalUrl: string;
  chain: RedirectHop[];
  totalDurationMs: number;
  isBlocked: boolean;
  error?: string;
}

export interface FollowRedirectOptions {
  maxHops?: number;
  timeoutPerHop?: number;
}

export const AFFILIATE_REDIRECT_DOMAINS = [
  'techsmartideas.com', 'financemasterpro.com', 'sweettoothrecipes.com',
  'ouo.io', 'ouo.press', 'shrinkme.io', 'linkvertise.com',
  'adf.ly', 'bc.vc', 'short.am', 'exe.io', 'stfly.me',
  'rexdl.com', 'lnkfy.com',
];

export class RedirectChainFollower {
  async followChain(
    page: Page,
    startUrl: string,
    options: FollowRedirectOptions = {},
  ): Promise<RedirectChainResult> {
    const { maxHops = 10, timeoutPerHop = 8000 } = options;
    const chain: RedirectHop[] = [];
    const startTime = Date.now();
    let currentUrl = startUrl;

    for (let hop = 0; hop < maxHops; hop++) {
      const hopStart = Date.now();

      try {
        const response = await page.goto(currentUrl, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutPerHop,
        });

        const status = response?.status() || 200;
        const finalHopUrl = page.url();
        const domain = new URL(finalHopUrl).hostname;
        const isAffiliate = this.isAffiliateDomain(domain);

        chain.push({
          order: hop,
          url: finalHopUrl,
          statusCode: status,
          domain,
          isAffiliate,
          durationMs: Date.now() - hopStart,
        });

        const blocked = await this.checkCloudflareBlock(page);
        if (blocked) {
          return {
            initialUrl: startUrl,
            finalUrl: finalHopUrl,
            chain,
            totalDurationMs: Date.now() - startTime,
            isBlocked: true,
            error: 'Cloudflare protection detected',
          };
        }

        if (finalHopUrl === currentUrl && hop > 0) break;
        if (!isAffiliate && hop > 0) break;

        currentUrl = finalHopUrl;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        chain.push({
          order: hop, url: currentUrl, statusCode: 0,
          domain: '', isAffiliate: false, durationMs: Date.now() - hopStart,
        });
        return {
          initialUrl: startUrl, finalUrl: currentUrl, chain,
          totalDurationMs: Date.now() - startTime, isBlocked: false, error: msg,
        };
      }
    }

    return {
      initialUrl: startUrl,
      finalUrl: chain[chain.length - 1]?.url || startUrl,
      chain,
      totalDurationMs: Date.now() - startTime,
      isBlocked: false,
    };
  }

  async checkCloudflareBlock(page: Page): Promise<boolean> {
    try {
      const title = await page.title();
      if (/cloudflare|attention required|just a moment|checking your browser/i.test(title)) return true;

      const hasChallenge = await page.evaluate(() => {
        return !!(
          document.getElementById('challenge-form')
          || document.querySelector('.cf-browser-verify')
          || document.querySelector('iframe[src*="cloudflare"]')
        );
      }).catch(() => false);

      return hasChallenge;
    } catch {
      return false;
    }
  }

  isAffiliateDomain(domain: string): boolean {
    return AFFILIATE_REDIRECT_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
  }

  async extractFinalUrls(page: Page): Promise<string[]> {
    const urls: string[] = [];
    try {
      const iframeUrls = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('iframe'))
          .map(f => f.src)
          .filter(s => s && s.startsWith('http') && s !== 'about:blank');
      });
      urls.push(...iframeUrls);

      const scriptUrls = await page.evaluate(() => {
        const found: string[] = [];
        document.querySelectorAll('script').forEach(s => {
          const text = s.textContent || '';
          const matches = text.match(/https?:\/\/[^\s"'\\]+/g) || [];
          matches.forEach(u => { if (!found.includes(u)) found.push(u); });
        });
        return found;
      });
      urls.push(...scriptUrls);

      const imgUrls = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('img'))
          .map(img => img.src || img.getAttribute('data-src') || img.getAttribute('lazy_url') || '')
          .filter(s => s.startsWith('http'));
      });
      urls.push(...imgUrls);
    } catch (err) {
      getLogger().warn({ error: String(err) }, 'extractFinalUrls failed');
    }
    return [...new Set(urls)];
  }
}
