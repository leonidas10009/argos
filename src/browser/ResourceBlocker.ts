import type { Page } from 'puppeteer';
import { getLogger } from '../utils/logger';

type ResourceType =
  | 'document'
  | 'stylesheet'
  | 'image'
  | 'media'
  | 'font'
  | 'script'
  | 'texttrack'
  | 'xhr'
  | 'fetch'
  | 'prefetch'
  | 'eventsource'
  | 'websocket'
  | 'manifest'
  | 'signedexchange'
  | 'ping'
  | 'cspviolationreport'
  | 'preflight'
  | 'other';

const BLOCKED_TYPES: ResourceType[] = [
  'image',
  'media',
  'font',
  'stylesheet',
  'ping',
];

export async function setupResourceBlocking(page: Page): Promise<void> {
  const log = getLogger();
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const type = request.resourceType() as ResourceType;
    if (BLOCKED_TYPES.includes(type)) {
      log.trace({ url: request.url(), type }, 'Blocked resource');
      request.abort();
    } else {
      request.continue();
    }
  });

  log.debug('Resource blocking enabled');
}

export function blockResourcesOnly(req: { resourceType(): string; abort(): void; continue(): void }): void {
  const type = req.resourceType() as ResourceType;
  if (BLOCKED_TYPES.includes(type)) {
    req.abort();
  } else {
    req.continue();
  }
}
