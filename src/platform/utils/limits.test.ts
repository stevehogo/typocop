import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import {
  MAX_FILE_SIZE_BYTES,
  MAX_GRAPH_SIZE_NODES,
  QUERY_TIMEOUT_MS,
  MAX_TRAVERSAL_DEPTH,
  PARSE_CONCURRENCY,
  MAX_PARSE_THREADS,
  PARSE_WORKER_THRESHOLD,
  PARSE_THREADS_ENV,
  PARSE_WORKER_THRESHOLD_ENV,
  defaultParseThreads,
  getConfiguredParseThreads,
  getConfiguredParseWorkerThreshold,
  PARSE_WORKERS_ENV,
  isParseWorkersEnabled,
  EMBEDDING_CONCURRENCY,
  EMBEDDING_TIMEOUT_MS,
  DB_WRITE_BATCH_SIZE,
  isFileSizeValid,
  isGraphSizeValid,
  withQueryTimeout,
  withTimeoutOr,
  isTraversalDepthValid,
} from './limits.js';

describe('defaultParseThreads (B2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reserves one core for the main thread (cpus-1)', () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(8);
    expect(defaultParseThreads()).toBe(7);
  });

  it('clamps to at least 1 on a single-core machine', () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(1);
    expect(defaultParseThreads()).toBe(1);
  });

  it('clamps to MAX_PARSE_THREADS on a many-core machine', () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(128);
    expect(defaultParseThreads()).toBe(MAX_PARSE_THREADS);
    expect(MAX_PARSE_THREADS).toBe(16);
  });

  it('falls back to cpus().length when availableParallelism is unavailable', () => {
    // Simulate an older/exotic platform lacking availableParallelism.
    const orig = os.availableParallelism;
    // @ts-expect-error — deliberately removing to exercise the fallback branch.
    os.availableParallelism = undefined;
    const cpusSpy = vi
      .spyOn(os, 'cpus')
      .mockReturnValue(new Array(4).fill({}) as ReturnType<typeof os.cpus>);
    try {
      expect(defaultParseThreads()).toBe(3);
      expect(cpusSpy).toHaveBeenCalled();
    } finally {
      os.availableParallelism = orig;
    }
  });

  it('guards against a 0/NaN parallelism report', () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(0);
    expect(defaultParseThreads()).toBe(1);
  });
});

describe('getConfiguredParseThreads (B2)', () => {
  beforeEach(() => {
    delete process.env[PARSE_THREADS_ENV];
  });
  afterEach(() => {
    delete process.env[PARSE_THREADS_ENV];
    vi.restoreAllMocks();
  });

  it('falls back to defaultParseThreads when the env is unset', () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(8);
    expect(getConfiguredParseThreads()).toBe(7);
  });

  it('falls back to defaultParseThreads when the env is empty', () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(8);
    process.env[PARSE_THREADS_ENV] = '';
    expect(getConfiguredParseThreads()).toBe(7);
  });

  it('honors a positive integer override (not re-clamped to core count)', () => {
    vi.spyOn(os, 'availableParallelism').mockReturnValue(2);
    process.env[PARSE_THREADS_ENV] = '32';
    expect(getConfiguredParseThreads()).toBe(32);
  });

  it('rejects zero', () => {
    process.env[PARSE_THREADS_ENV] = '0';
    expect(() => getConfiguredParseThreads()).toThrow(PARSE_THREADS_ENV);
  });

  it('rejects negative values', () => {
    process.env[PARSE_THREADS_ENV] = '-4';
    expect(() => getConfiguredParseThreads()).toThrow(PARSE_THREADS_ENV);
  });

  it('rejects non-numeric values', () => {
    process.env[PARSE_THREADS_ENV] = 'lots';
    expect(() => getConfiguredParseThreads()).toThrow(PARSE_THREADS_ENV);
  });

  it('rejects non-integer values', () => {
    process.env[PARSE_THREADS_ENV] = '2.5';
    expect(() => getConfiguredParseThreads()).toThrow(PARSE_THREADS_ENV);
  });
});

describe('PARSE_WORKER_THRESHOLD (B2)', () => {
  beforeEach(() => {
    delete process.env[PARSE_WORKER_THRESHOLD_ENV];
  });
  afterEach(() => {
    delete process.env[PARSE_WORKER_THRESHOLD_ENV];
  });

  it('defaults to 64', () => {
    expect(PARSE_WORKER_THRESHOLD).toBe(64);
  });

  it('falls back to PARSE_WORKER_THRESHOLD when the env is unset', () => {
    expect(getConfiguredParseWorkerThreshold()).toBe(PARSE_WORKER_THRESHOLD);
  });

  it('honors a positive integer override', () => {
    process.env[PARSE_WORKER_THRESHOLD_ENV] = '128';
    expect(getConfiguredParseWorkerThreshold()).toBe(128);
  });

  it('rejects zero / negative / non-numeric values', () => {
    for (const bad of ['0', '-1', 'nope', '1.5']) {
      process.env[PARSE_WORKER_THRESHOLD_ENV] = bad;
      expect(() => getConfiguredParseWorkerThreshold()).toThrow(PARSE_WORKER_THRESHOLD_ENV);
    }
  });
});

describe('isParseWorkersEnabled (opt-in, default off)', () => {
  beforeEach(() => {
    delete process.env[PARSE_WORKERS_ENV];
  });
  afterEach(() => {
    delete process.env[PARSE_WORKERS_ENV];
  });

  it('is false when the env is unset (proven in-process path is the default)', () => {
    expect(isParseWorkersEnabled()).toBe(false);
  });

  it('is true for truthy opt-in values', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
      process.env[PARSE_WORKERS_ENV] = v;
      expect(isParseWorkersEnabled()).toBe(true);
    }
  });

  it('is false for empty / falsy / garbage values', () => {
    for (const v of ['', '0', 'false', 'no', 'off', 'maybe']) {
      process.env[PARSE_WORKERS_ENV] = v;
      expect(isParseWorkersEnabled()).toBe(false);
    }
  });
});

describe('PARSE_CONCURRENCY', () => {
  it('is a positive integer in a sane range (B5 conservative default)', () => {
    expect(Number.isInteger(PARSE_CONCURRENCY)).toBe(true);
    expect(PARSE_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(PARSE_CONCURRENCY).toBeLessThanOrEqual(16);
  });
});

describe('EMBEDDING_CONCURRENCY', () => {
  it('is a small positive integer safe for local backends (Phase C, 2-4)', () => {
    expect(Number.isInteger(EMBEDDING_CONCURRENCY)).toBe(true);
    expect(EMBEDDING_CONCURRENCY).toBeGreaterThanOrEqual(2);
    expect(EMBEDDING_CONCURRENCY).toBeLessThanOrEqual(4);
  });
});

describe('EMBEDDING_TIMEOUT_MS', () => {
  it('is a positive duration', () => {
    expect(EMBEDDING_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('DB_WRITE_BATCH_SIZE', () => {
  it('is a bounded positive integer chunk size (Phase D)', () => {
    expect(Number.isInteger(DB_WRITE_BATCH_SIZE)).toBe(true);
    expect(DB_WRITE_BATCH_SIZE).toBeGreaterThanOrEqual(1);
    // Bounded so a single batch write stays a reasonable statement/payload size.
    expect(DB_WRITE_BATCH_SIZE).toBeLessThanOrEqual(10_000);
  });
});

describe('withTimeoutOr', () => {
  it('resolves with the operation result when it completes in time', async () => {
    const result = await withTimeoutOr(async () => 'ok', 100, 'fallback');
    expect(result).toBe('ok');
  });

  it('resolves with the sentinel value when the operation times out', async () => {
    const result = await withTimeoutOr(
      async () => {
        await new Promise((r) => setTimeout(r, 200));
        return 'late';
      },
      20,
      'fallback',
    );
    expect(result).toBe('fallback');
  });

  it('supports a lazy sentinel factory', async () => {
    const result = await withTimeoutOr(
      () => new Promise<number>((r) => setTimeout(() => r(1), 200)),
      20,
      () => 42,
    );
    expect(result).toBe(42);
  });

  it('still rejects when the operation itself throws', async () => {
    await expect(
      withTimeoutOr(async () => {
        throw new Error('inner failure');
      }, 100, 'fallback'),
    ).rejects.toThrow('inner failure');
  });

  it('does not keep a timer pending after a fast resolve', async () => {
    vi.useFakeTimers();
    try {
      const setSpy = vi.spyOn(global, 'setTimeout');
      const clearSpy = vi.spyOn(global, 'clearTimeout');
      const p = withTimeoutOr(async () => 'fast', 1000, 'fallback');
      await vi.runAllTimersAsync();
      await expect(p).resolves.toBe('fast');
      expect(setSpy).toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isFileSizeValid', () => {
  it('returns true for file sizes within limit', () => {
    expect(isFileSizeValid(1024)).toBe(true);
    expect(isFileSizeValid(MAX_FILE_SIZE_BYTES)).toBe(true);
    expect(isFileSizeValid(MAX_FILE_SIZE_BYTES - 1)).toBe(true);
  });

  it('returns false for file sizes exceeding limit', () => {
    expect(isFileSizeValid(MAX_FILE_SIZE_BYTES + 1)).toBe(false);
    expect(isFileSizeValid(MAX_FILE_SIZE_BYTES * 2)).toBe(false);
  });

  it('returns false for zero or negative sizes', () => {
    expect(isFileSizeValid(0)).toBe(false);
    expect(isFileSizeValid(-1)).toBe(false);
    expect(isFileSizeValid(-1000)).toBe(false);
  });
});

describe('isGraphSizeValid', () => {
  it('returns true for graph sizes within limit', () => {
    expect(isGraphSizeValid(0)).toBe(true);
    expect(isGraphSizeValid(1000)).toBe(true);
    expect(isGraphSizeValid(MAX_GRAPH_SIZE_NODES)).toBe(true);
    expect(isGraphSizeValid(MAX_GRAPH_SIZE_NODES - 1)).toBe(true);
  });

  it('returns false for graph sizes exceeding limit', () => {
    expect(isGraphSizeValid(MAX_GRAPH_SIZE_NODES + 1)).toBe(false);
    expect(isGraphSizeValid(MAX_GRAPH_SIZE_NODES * 2)).toBe(false);
  });

  it('returns false for negative sizes', () => {
    expect(isGraphSizeValid(-1)).toBe(false);
    expect(isGraphSizeValid(-1000)).toBe(false);
  });
});

describe('withQueryTimeout', () => {
  it('resolves with query result when query completes within timeout', async () => {
    const queryFn = async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'success';
    };

    const result = await withQueryTimeout(queryFn, 100);
    expect(result).toBe('success');
  });

  it('rejects with timeout error when query exceeds timeout', async () => {
    const queryFn = async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      return 'success';
    };

    await expect(withQueryTimeout(queryFn, 50)).rejects.toThrow('Query execution exceeded timeout of 50ms');
  });

  it('uses default timeout when not specified', async () => {
    const queryFn = async () => {
      await new Promise(resolve => setTimeout(resolve, QUERY_TIMEOUT_MS + 100));
      return 'success';
    };

    await expect(withQueryTimeout(queryFn)).rejects.toThrow(`Query execution exceeded timeout of ${QUERY_TIMEOUT_MS}ms`);
  });

  it('propagates query errors', async () => {
    const queryFn = async () => {
      throw new Error('Query failed');
    };

    await expect(withQueryTimeout(queryFn, 100)).rejects.toThrow('Query failed');
  });

  it('handles synchronous query functions', async () => {
    const queryFn = async () => 'immediate';

    const result = await withQueryTimeout(queryFn, 100);
    expect(result).toBe('immediate');
  });
});

describe('isTraversalDepthValid', () => {
  it('returns true for depths within limit', () => {
    expect(isTraversalDepthValid(0)).toBe(true);
    expect(isTraversalDepthValid(10)).toBe(true);
    expect(isTraversalDepthValid(MAX_TRAVERSAL_DEPTH)).toBe(true);
    expect(isTraversalDepthValid(MAX_TRAVERSAL_DEPTH - 1)).toBe(true);
  });

  it('returns false for depths exceeding limit', () => {
    expect(isTraversalDepthValid(MAX_TRAVERSAL_DEPTH + 1)).toBe(false);
    expect(isTraversalDepthValid(MAX_TRAVERSAL_DEPTH * 2)).toBe(false);
  });

  it('returns false for negative depths', () => {
    expect(isTraversalDepthValid(-1)).toBe(false);
    expect(isTraversalDepthValid(-10)).toBe(false);
  });
});
