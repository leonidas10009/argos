import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ProfileBuilder } from '../src/analysis/ProfileBuilder';
import { NavigationMapper } from '../src/analysis/NavigationMapper';
import { LearnedKB, getLearnedKB, resetLearnedKB } from '../src/analysis/LearnedKnowledgeBase';
import { ProfileExporter } from '../src/analysis/ProfileExporter';
import type { SmartScrapeResult } from '../src/analysis/AutonomousScraper';

const TEST_PATH = join(process.cwd(), '.test-learned-kb.json');

function makeResult(overrides: Partial<SmartScrapeResult> = {}): SmartScrapeResult {
  return {
    url: 'https://example.com/ver/test',
    title: 'Test Page',
    steps: [
      { step: 1, action: 'group', target: '.cards', reasoning: 'Grupo: listing cards:item', result: { action: 'group', target: '.cards', success: true, changes: 0, newUrls: [] } },
      { step: 2, action: 'navigate', target: 'a.card-link', reasoning: 'Siguiendo: "Test Movie"', result: { action: 'navigate', target: 'a.card-link', success: true, changes: 3, newUrls: ['https://example.com/ver/test'] } },
      { step: 3, action: 'group', target: '.server-list', reasoning: 'Grupo: Servers: server, servidor', result: { action: 'group', target: '.server-list', success: true, changes: 0, newUrls: [] } },
      { step: 4, action: 'content-servers', target: '.btn-server', reasoning: 'Servers: opcion 1, opcion 2', result: { action: 'content-servers', target: '.btn-server', success: true, changes: 2, newUrls: ['https://embed.host.com/abc'] } },
      { step: 5, action: 'search', target: '#search-input', reasoning: 'Buscando: "naruto"', result: { action: 'search', target: '#search-input', success: true, changes: 0, newUrls: [] } },
    ],
    serverCatalog: [
      { name: 'EmbedHost', domain: 'embed.host.com', urls: [{ url: 'https://embed.host.com/abc', type: 'embed', label: 'Server 1', quality: '1080p', language: 'ES' }] },
      { name: 'Example', domain: 'example.com', urls: [{ url: 'https://example.com/ver/test', type: 'navigation', label: 'detail page', quality: 'unknown', language: 'ES' }] },
    ],
    streams: [],
    findings: {
      videoUrls: [],
      downloadUrls: [],
      serverUrls: ['https://embed.host.com/abc'],
      navigationUrls: ['https://example.com/ver/test', 'https://example.com/ver/other'],
      otherUrls: [],
    },
    model: { roles: ['link', 'clickable', 'image'], totalElements: 50, interactions: 5 },
    durationMs: 12_000,
    partial: false,
    ...overrides,
  };
}

describe('ProfileBuilder', () => {
  const builder = new ProfileBuilder();

  it('builds site profile from scrape result', () => {
    const result = makeResult();
    const profile = builder.buildSiteProfile(result, 'example.com');
    expect(profile.domain).toBe('example.com');
    expect(profile.visits).toBe(1);
    expect(profile.embedDomains).toContain('embed.host.com');
  });

  it('generates provider config from successful scrape', () => {
    const result = makeResult();
    const config = builder.generateProviderConfig(result, 'example.com', 'https://example.com');
    expect(config).not.toBeNull();
    expect(config!.name).toBe('example.com');
    expect(config!.videos.type).toBe('iframe');
  });

  it('returns null for empty results', () => {
    const empty = makeResult({ serverCatalog: [], steps: [] });
    const config = builder.generateProviderConfig(empty, 'empty.com', 'https://empty.com');
    expect(config).toBeNull();
  });
});

describe('NavigationMapper', () => {
  const mapper = new NavigationMapper();

  it('builds navigation map with nodes and edges', () => {
    const result = makeResult();
    const map = mapper.buildMap(result, 'https://example.com');
    expect(map.domain).toBe('example.com');
    expect(Object.keys(map.nodes).length).toBeGreaterThan(0);
    expect(map.edges.length).toBeGreaterThan(0);
  });

  it('merges two maps accumulating knowledge', () => {
    const result1 = makeResult();
    const result2 = makeResult({ url: 'https://example.com/ver/test2' });
    const map1 = mapper.buildMap(result1, 'https://example.com');
    const map2 = mapper.buildMap(result2, 'https://example.com');
    const merged = mapper.merge(map1, map2);
    expect(Object.keys(merged.nodes).length).toBeGreaterThanOrEqual(Object.keys(map1.nodes).length);
  });
});

describe('LearnedKB', () => {
  beforeEach(() => {
    try { unlinkSync(TEST_PATH); } catch { /* ok */ }
    resetLearnedKB();
  });
  afterEach(() => {
    try { unlinkSync(TEST_PATH); } catch { /* ok */ }
  });

  it('starts empty', () => {
    const kb = new LearnedKB(TEST_PATH);
    expect(kb.getData().totalDiscoveries).toBe(0);
  });

  it('adds domain from embed result', () => {
    const kb = new LearnedKB(TEST_PATH);
    kb.addDomain('new-embed.com', {
      embedUrl: 'https://new-embed.com/e/123',
      directUrl: 'https://cdn.com/video.mp4',
      serverName: 'NewEmbed',
      domain: 'new-embed.com',
      method: 'generic',
      durationMs: 500,
    });
    expect(kb.getData().totalDiscoveries).toBe(1);
    expect(kb.getData().domains['new-embed.com']).toBeDefined();
  });

  it('adds selector from exploration', () => {
    const kb = new LearnedKB(TEST_PATH);
    kb.addSelector('.btn-server', 'example.com', 'content-servers', true);
    kb.addSelector('.btn-server', 'example.com', 'content-servers', true);
    kb.addSelector('.btn-server', 'example.com', 'content-servers', false);
    const selectors = kb.getSelectorsForDomain('example.com');
    expect(selectors.length).toBe(1);
    expect(selectors[0]!.successRate).toBeCloseTo(2 / 3);
  });

  it('persists and loads', () => {
    const kb1 = new LearnedKB(TEST_PATH);
    kb1.addDomain('test.com', {
      embedUrl: 'https://test.com/e/1', directUrl: null,
      serverName: 'Test', domain: 'test.com', method: 'generic', durationMs: 100,
    });
    kb1.save();

    const kb2 = new LearnedKB(TEST_PATH);
    expect(kb2.getData().domains['test.com']).toBeDefined();
  });
});

describe('ProfileExporter', () => {
  it('processes result and exports profile', () => {
    const exporter = new ProfileExporter();
    const result = makeResult();
    exporter.processResult(result, 'example.com', 'https://example.com');

    const exported = exporter.export();
    expect(exported.version).toBe(1);
    expect(exported.providers.length).toBeGreaterThanOrEqual(1);
    expect(exported.siteProfiles['example.com']).toBeDefined();
  });

  it('imports and merges profiles', () => {
    const exporter = new ProfileExporter();
    const result = makeResult();
    exporter.processResult(result, 'example.com', 'https://example.com');
    const data = exporter.export();

    const exporter2 = new ProfileExporter();
    exporter2.import(data);
    expect(exporter2.getProfile('example.com')).toBeDefined();
  });

  it('gets providers from exports', () => {
    const exporter = new ProfileExporter();
    const result = makeResult();
    exporter.processResult(result, 'example.com', 'https://example.com');
    const providers = exporter.getProviders();
    expect(providers.length).toBeGreaterThanOrEqual(1);
    expect(providers[0]!.videos).toBeDefined();
  });
});
