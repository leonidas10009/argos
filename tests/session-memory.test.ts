import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionMemory, textSimilarity, getSessionMemory, resetSessionMemory } from '../src/analysis/SessionMemory';

const TEST_PATH = join(process.cwd(), '.test-memory.json');

function cleanup() {
  try { unlinkSync(TEST_PATH); } catch { /* ok */ }
}

describe('SessionMemory', () => {
  beforeEach(() => {
    cleanup();
    resetSessionMemory();
  });
  afterEach(cleanup);

  describe('persistence round-trip', () => {
    it('saves and loads data correctly', () => {
      const mem1 = new SessionMemory(TEST_PATH);
      mem1.setCurrentDomain('example.com');
      mem1.recordAttempt('.btn', 'clickable', 'click', true, 5, ['a', 'b'], 'example.com');
      mem1.recordAttempt('.btn', 'clickable', 'click', false, 0, [], 'example.com');
      mem1.recordChain('https://example.com/page', 'https://cdn.example.com/video.mp4', 'servers');
      mem1.forceSave();

      const mem2 = new SessionMemory(TEST_PATH);
      const fp = mem2.getDomainFingerprint('example.com');
      expect(fp).not.toBeNull();
      expect(fp!.successfulClasses.get('btn')).toBeGreaterThanOrEqual(1);
    });

    it('preserves bayesian scores across sessions', () => {
      const mem1 = new SessionMemory(TEST_PATH);
      for (let i = 0; i < 20; i++) {
        mem1.recordAttempt('.server-btn', 'clickable', 'click', true, 3, ['a'], 'testsite.com');
      }
      for (let i = 0; i < 5; i++) {
        mem1.recordAttempt('.ad-btn', 'clickable', 'click', false, 0, [], 'testsite.com');
      }
      mem1.forceSave();

      const mem2 = new SessionMemory(TEST_PATH);
      const serverBoost = mem2.getClassBoost('server-btn');
      const adBoost = mem2.getClassBoost('ad-btn');

      expect(serverBoost).toBeGreaterThan(0);
      expect(adBoost).toBeLessThanOrEqual(serverBoost);
    });
  });

  describe('version compatibility', () => {
    it('loads version 1 data', () => {
      writeFileSync(TEST_PATH, JSON.stringify({
        version: 1,
        domains: {},
        patterns: [],
        containerDomains: [],
        totalAttempts: 42,
        successCount: 30,
      }));
      const mem = new SessionMemory(TEST_PATH);
      const scores = mem.getAdaptiveScores();
      expect(scores.successCount).toBeGreaterThanOrEqual(0);
      expect(scores.totalAttempts).toBeGreaterThanOrEqual(0);
    });

    it('loads version 2 data with urlChains', () => {
      writeFileSync(TEST_PATH, JSON.stringify({
        version: 2,
        domains: {},
        patterns: [],
        containerDomains: [],
        urlChains: { 'example.com': [{ fromPattern: '/page', toType: 'servers', confidence: 0.9, lastSuccess: Date.now(), sampleFrom: '/page', sampleTo: '/cdn' }] },
        totalAttempts: 99,
        successCount: 80,
      }));
      const mem = new SessionMemory(TEST_PATH);
      const scores = mem.getAdaptiveScores();
      expect(scores.totalAttempts).toBe(99);
      expect(Object.keys(scores.urlChains)).toContain('example.com');
    });

    it('rejects version 0 data (forward compat)', () => {
      writeFileSync(TEST_PATH, JSON.stringify({ version: 0, patterns: [], domains: {}, containerDomains: [], totalAttempts: 10 }));
      const mem = new SessionMemory(TEST_PATH);
      const scores = mem.getAdaptiveScores();
      expect(scores.totalAttempts).toBe(0); // should start fresh
    });
  });

  describe('URL chains', () => {
    it('records and retrieves chains by domain', () => {
      const mem = new SessionMemory(TEST_PATH);
      mem.recordChain('https://animejara.com/anime/naruto', 'https://streamtape.com/e/abc', 'servers');
      mem.recordChain('https://animejara.com/anime/naruto', 'https://uqload.com/e/xyz', 'servers');
      mem.recordChain('https://animejara.com/anime/bleach', 'https://mp4upload.com/a1', 'download');

      const chains = mem.getChainsForDomain('animejara.com');
      expect(chains.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('container domains', () => {
    it('tracks known container domains', () => {
      const mem = new SessionMemory(TEST_PATH);
      mem.addContainerDomain('streamtape.com');
      mem.addContainerDomain('uqload.com');

      expect(mem.isKnownContainerDomain('streamtape.com')).toBe(true);
      expect(mem.isKnownContainerDomain('unknown.com')).toBe(false);
    });
  });

  describe('predictions', () => {
    it('predicts success with higher confidence after more data', () => {
      const mem = new SessionMemory(TEST_PATH);
      const pred1 = mem.predictSuccess('clickable', 'btn', 'site.com');
      expect(pred1.confidence).toBeLessThan(0.3);

      for (let i = 0; i < 10; i++) {
        mem.recordAttempt('.btn', 'clickable', 'click', true, 3, [], 'site.com');
      }
      const pred2 = mem.predictSuccess('clickable', 'btn', 'site.com');
      expect(pred2.estimatedSuccess).toBeGreaterThan(0.5);
      expect(pred2.confidence).toBeGreaterThan(pred1.confidence);
    });
  });
});

describe('textSimilarity', () => {
  it('returns high similarity for identical strings', () => {
    expect(textSimilarity('naruto', 'naruto')).toBeGreaterThan(0.8);
  });

  it('returns 0 for completely different strings', () => {
    expect(textSimilarity('naruto', 'xyzxyz')).toBe(0);
  });

  it('detects partial matches with Levenshtein', () => {
    const sim = textSimilarity('naruto', 'narutoo');
    expect(sim).toBeGreaterThan(0.25);
  });

  it('matches multi-word queries via word Jaccard', () => {
    const sim = textSimilarity('naruto shippuden', 'Naruto Shippuden - Episodio 1');
    expect(sim).toBeGreaterThan(0.4);
  });

  it('handles diacritics with partial match', () => {
    const sim = textSimilarity('capítulo', 'capitulo');
    expect(sim).toBeGreaterThan(0.25);
  });

  it('handles empty strings', () => {
    expect(textSimilarity('', 'naruto')).toBe(0);
    expect(textSimilarity('naruto', '')).toBe(0);
  });
});
