import { getLogger } from './logger';

export interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  opsPerSec: number;
}

/**
 * Simple benchmark runner for internal operations.
 * Not for browser-based scraping (those depend on network).
 * Use for algorithm/parsing performance measurement.
 */
export class Benchmark {
  /**
   * Run a synchronous function multiple times and measure performance.
   */
  static measure(name: string, fn: () => void, iterations = 1000): BenchmarkResult {
    const times: number[] = [];
    const warmup = 3;
    for (let i = 0; i < warmup; i++) fn();

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      fn();
      times.push(performance.now() - start);
    }

    times.sort((a, b) => a - b);
    const total = times.reduce((a, b) => a + b, 0);

    const result: BenchmarkResult = {
      name,
      iterations,
      totalMs: Math.round(total * 100) / 100,
      avgMs: Math.round(total / iterations * 1000) / 1000,
      minMs: Math.round(times[0]! * 1000) / 1000,
      maxMs: Math.round(times[times.length - 1]! * 1000) / 1000,
      p50Ms: Math.round(times[Math.floor(iterations * 0.5)]! * 1000) / 1000,
      p95Ms: Math.round(times[Math.floor(iterations * 0.95)]! * 1000) / 1000,
      opsPerSec: Math.round(iterations / (total / 1000)),
    };

    getLogger().info(result, `Benchmark: ${name}`);
    return result;
  }

  /**
   * Run an async function and measure.
   */
  static async measureAsync(name: string, fn: () => Promise<void>, iterations = 100): Promise<BenchmarkResult> {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) await fn();

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await fn();
      times.push(performance.now() - start);
    }

    times.sort((a, b) => a - b);
    const total = times.reduce((a, b) => a + b, 0);

    const result: BenchmarkResult = {
      name,
      iterations,
      totalMs: Math.round(total * 100) / 100,
      avgMs: Math.round(total / iterations * 1000) / 1000,
      minMs: Math.round(times[0]! * 1000) / 1000,
      maxMs: Math.round(times[times.length - 1]! * 1000) / 1000,
      p50Ms: Math.round(times[Math.floor(iterations * 0.5)]! * 1000) / 1000,
      p95Ms: Math.round(times[Math.floor(iterations * 0.95)]! * 1000) / 1000,
      opsPerSec: Math.round(iterations / (total / 1000)),
    };

    getLogger().info(result, `Benchmark: ${name}`);
    return result;
  }

  /**
   * Compare two implementations.
   */
  static compare(name: string, fnA: () => void, fnB: () => void, iterations = 1000): { a: BenchmarkResult; b: BenchmarkResult; speedup: number } {
    const a = Benchmark.measure(`${name} (A)`, fnA, iterations);
    const b = Benchmark.measure(`${name} (B)`, fnB, iterations);
    const speedup = Math.round(a.avgMs / b.avgMs * 100) / 100;
    getLogger().info({ speedup, aAvg: a.avgMs, bAvg: b.avgMs }, `Benchmark compare: ${name}`);
    return { a, b, speedup };
  }
}
