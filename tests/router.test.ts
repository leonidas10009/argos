import { describe, it, expect } from 'vitest';
import { Router } from '../src/engines/Router';
import { CircuitBreaker } from '../src/analysis/CircuitBreaker';

describe('Router', () => {
  const cb = new CircuitBreaker(5, 300_000, 2);

  it('returns error result for unknown provider', async () => {
    const router = new Router(cb);
    const result = await router.execute(
      {
        provider: {
          name: 'nonexistent',
          title: 'Test',
          baseUrl: 'https://test.com',
          language: 'ES',
          categories: [],
          active: true,
          search: { url: '/search', itemSelector: '.item', titleSelector: 'h3', linkSelector: 'a' },
          videos: { type: 'none' },
        },
        phase: 'search',
      },
      null,
    );
    expect(result.success).toBe(false);
    expect(result.provider).toBe('nonexistent');
  });
});
