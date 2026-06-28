import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../src/analysis/CircuitBreaker';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker(3, 1000, 2); // 3 failures → open, 1s reset, 2 half-open successes
  });

  describe('basic execution', () => {
    it('executes function and returns result', async () => {
      const result = await cb.execute('test', async () => 'ok');
      expect(result).toBe('ok');
    });

    it('records success', () => {
      cb.recordSuccess('test');
      const state = cb.getState('test');
      expect(state.state).toBe('closed');
      expect(state.successes).toBe(1);
    });

    it('re-throws function errors', async () => {
      await expect(
        cb.execute('test', async () => { throw new Error('fail'); })
      ).rejects.toThrow('fail');
    });
  });

  describe('state transitions', () => {
    it('opens circuit after threshold failures', async () => {
      for (let i = 0; i < 3; i++) {
        try { await cb.execute('test', async () => { throw new Error('x'); }); } catch { /* ok */ }
      }
      const state = cb.getState('test');
      expect(state.state).toBe('open');
    });

    it('throws CircuitOpenError when circuit is open', async () => {
      for (let i = 0; i < 3; i++) {
        try { await cb.execute('test', async () => { throw new Error('x'); }); } catch { /* ok */ }
      }
      await expect(
        cb.execute('test', async () => 'ok')
      ).rejects.toThrow(CircuitOpenError);
    });

    it('goes to half-open after reset timeout', async () => {
      // Override Date.now for deterministic testing
      const cbFast = new CircuitBreaker(3, 10, 2);
      for (let i = 0; i < 3; i++) {
        try { await cbFast.execute('test', async () => { throw new Error('x'); }); } catch { /* ok */ }
      }
      expect(cbFast.getState('test').state).toBe('open');

      await new Promise(r => setTimeout(r, 20)); // wait for reset timeout
      expect(cbFast.shouldSkip('test')).toBe(false);
      expect(cbFast.getState('test').state).toBe('half-open');
    });

    it('closes circuit after enough half-open successes', async () => {
      const cbFast = new CircuitBreaker(3, 10, 2);
      for (let i = 0; i < 3; i++) {
        try { await cbFast.execute('test', async () => { throw new Error('x'); }); } catch { /* ok */ }
      }
      await new Promise(r => setTimeout(r, 20));

      // 2 successful half-open attempts → closed
      for (let i = 0; i < 2; i++) {
        await cbFast.execute('test', async () => 'ok');
      }
      expect(cbFast.getState('test').state).toBe('closed');
    });
  });

  describe('shouldSkip', () => {
    it('returns false for closed circuit', () => {
      expect(cb.shouldSkip('test')).toBe(false);
    });

    it('returns true for open circuit', async () => {
      for (let i = 0; i < 3; i++) {
        cb.recordFailure('test');
      }
      expect(cb.shouldSkip('test')).toBe(true);
    });
  });

  describe('bulk operations', () => {
    it('getAllStates returns all tracked providers', () => {
      cb.recordSuccess('A');
      cb.recordFailure('B');
      const states = cb.getAllStates();
      expect(states.length).toBe(2);
      expect(states.map(s => s.provider)).toContain('A');
      expect(states.map(s => s.provider)).toContain('B');
    });

    it('getFailingProviders returns only open circuits', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('bad');
      cb.recordSuccess('good');
      expect(cb.getFailingProviders()).toContain('bad');
      expect(cb.getFailingProviders()).not.toContain('good');
    });

    it('getHealthyProviders returns only closed circuits', () => {
      for (let i = 0; i < 3; i++) cb.recordFailure('bad');
      cb.recordSuccess('good');
      expect(cb.getHealthyProviders()).toContain('good');
      expect(cb.getHealthyProviders()).not.toContain('bad');
    });

    it('reset clears a specific circuit', () => {
      cb.recordFailure('test');
      cb.reset('test');
      const state = cb.getState('test');
      expect(state.failures).toBe(0);
    });

    it('resetAll clears all circuits', () => {
      cb.recordFailure('A');
      cb.recordFailure('B');
      cb.resetAll();
      expect(cb.getAllStates().length).toBe(0);
    });
  });
});
