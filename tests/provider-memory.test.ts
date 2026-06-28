import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderMemory, getProviderMemory, resetProviderMemory } from '../src/analysis/ProviderMemory';
import { getSessionMemory, resetSessionMemory } from '../src/analysis/SessionMemory';

const TEST_PATH = join(process.cwd(), '.test-provider-memory.json');

function cleanup() {
  try { unlinkSync(TEST_PATH); } catch { /* ok */ }
  try { unlinkSync(join(process.cwd(), '.test-memory.json')); } catch { /* ok */ }
}

describe('ProviderMemory', () => {
  beforeEach(() => {
    cleanup();
    resetProviderMemory();
    resetSessionMemory();
  });
  afterEach(cleanup);

  describe('engine tracking', () => {
    it('records successful engine attempt', () => {
      const mem = new ProviderMemory(TEST_PATH);
      mem.recordEngineAttempt('test-site', 'static', 'search', true, 250, 5);
      mem.recordEngineAttempt('test-site', 'static', 'search', true, 300, 3);

      const stats = mem.getProviderStats('test-site');
      expect(stats).not.toBeNull();
      expect(stats!.totalAttempts).toBe(2);
      expect(stats!.successRate).toBe(100);
    });

    it('records failed attempt correctly', () => {
      const mem = new ProviderMemory(TEST_PATH);
      mem.recordEngineAttempt('test-site', 'dynamic', 'videos', false, 5000, 0);

      const stats = mem.getProviderStats('test-site');
      expect(stats!.successRate).toBe(0);
    });
  });

  describe('engine order', () => {
    it('returns default order for unknown providers', () => {
      const mem = new ProviderMemory(TEST_PATH);
      expect(mem.getEngineOrder('unknown')).toEqual(['static', 'intelligent', 'dynamic']);
    });

    it('ranks best engine first based on success rate', () => {
      const mem = new ProviderMemory(TEST_PATH);
      for (let i = 0; i < 10; i++) {
        mem.recordEngineAttempt('site', 'static', 'search', true, 200, 5);
      }
      for (let i = 0; i < 10; i++) {
        mem.recordEngineAttempt('site', 'dynamic', 'search', false, 5000, 0);
      }
      for (let i = 0; i < 5; i++) {
        mem.recordEngineAttempt('site', 'intelligent', 'search', true, 800, 3);
      }

      const order = mem.getEngineOrder('site');
      expect(order[0]).toBe('static');
      expect(order).toContain('dynamic');
      expect(order).toContain('intelligent');
    });

    it('includes all three engines in output', () => {
      const mem = new ProviderMemory(TEST_PATH);
      mem.recordEngineAttempt('site', 'static', 'search', true, 200, 5);
      const order = mem.getEngineOrder('site');
      expect(order.length).toBe(3);
      expect(order).toContain('static');
      expect(order).toContain('intelligent');
      expect(order).toContain('dynamic');
    });
  });

  describe('phases tracking', () => {
    it('tracks success/failure per phase', () => {
      const mem = new ProviderMemory(TEST_PATH);
      mem.recordEngineAttempt('site', 'static', 'search', true, 200, 5);
      mem.recordEngineAttempt('site', 'static', 'search', true, 250, 5);
      mem.recordEngineAttempt('site', 'static', 'videos', false, 3000, 0);

      const stats = mem.getProviderStats('site');
      const engine = stats!.engines['static'];
      expect(engine.phases['search'].successes).toBe(2);
      expect(engine.phases['videos'].failures).toBe(1);
    });
  });

  describe('cross-feed to SessionMemory', () => {
    it('feeds successful attempts to SessionMemory', () => {
      const mem = new ProviderMemory(TEST_PATH);
      mem.recordEngineAttempt('site', 'static', 'search', true, 200, 10);

      const session = getSessionMemory();
      const fp = session.getDomainFingerprint('site');
      // The cross-feed uses engine name as selector and 'provider' as elementType
      expect(fp).not.toBeNull();
    });
  });

  describe('bulk stats', () => {
    it('getAllStats returns sorted by success rate', () => {
      const mem = new ProviderMemory(TEST_PATH);
      for (let i = 0; i < 5; i++) mem.recordEngineAttempt('good', 'static', 'search', true, 100, 5);
      for (let i = 0; i < 5; i++) mem.recordEngineAttempt('bad', 'dynamic', 'search', false, 1000, 0);

      const all = mem.getAllStats();
      expect(all[0].name).toBe('good');
    });

    it('getTopProviders filters by minAttempts', () => {
      const mem = new ProviderMemory(TEST_PATH);
      mem.recordEngineAttempt('few', 'static', 'search', true, 100, 5); // 1 attempt
      for (let i = 0; i < 5; i++) mem.recordEngineAttempt('many', 'static', 'search', true, 100, 5);

      const top = mem.getTopProviders(3);
      expect(top.map(s => s.name)).toContain('many');
      expect(top.map(s => s.name)).not.toContain('few');
    });

    it('getFailingProviders returns below-threshold providers', () => {
      const mem = new ProviderMemory(TEST_PATH);
      for (let i = 0; i < 5; i++) mem.recordEngineAttempt('bad', 'dynamic', 'search', false, 1000, 0);
      for (let i = 0; i < 5; i++) mem.recordEngineAttempt('good', 'static', 'search', true, 100, 5);

      const failing = mem.getFailingProviders(3, 30);
      expect(failing.map(s => s.name)).toContain('bad');
      expect(failing.map(s => s.name)).not.toContain('good');
    });
  });

  describe('selector tracking', () => {
    it('tracks selector success rates', () => {
      const mem = new ProviderMemory(TEST_PATH);
      mem.recordSelectorAttempt('site', '.good-btn', 'search', true);
      mem.recordSelectorAttempt('site', '.good-btn', 'search', true);
      mem.recordSelectorAttempt('site', '.bad-btn', 'search', false);

      const best = mem.getBestSelectors('site');
      expect(best[0].selector).toBe('.good-btn');
      expect(best[0].successRate).toBe(1);
    });
  });

  describe('persistence', () => {
    it('saves and loads provider data', () => {
      const mem1 = new ProviderMemory(TEST_PATH);
      mem1.recordEngineAttempt('site', 'static', 'search', true, 200, 5);
      mem1.forceSave();

      const mem2 = new ProviderMemory(TEST_PATH);
      const stats = mem2.getProviderStats('site');
      expect(stats).not.toBeNull();
      expect(stats!.totalAttempts).toBe(1);
    });
  });

  describe('speed penalty', () => {
    it('prefers static over dynamic with same success rate', () => {
      const mem = new ProviderMemory(TEST_PATH);
      mem.recordEngineAttempt('site', 'static', 'search', true, 200, 5);
      mem.recordEngineAttempt('site', 'dynamic', 'search', true, 2000, 5);
      mem.recordEngineAttempt('site', 'intelligent', 'search', true, 800, 5);

      const order = mem.getEngineOrder('site');
      expect(order[0]).toBe('static');
    });
  });
});
