import { describe, it, expect, vi } from 'vitest';
import {
  MAX_FILE_SIZE_BYTES,
  MAX_GRAPH_SIZE_NODES,
  QUERY_TIMEOUT_MS,
  MAX_TRAVERSAL_DEPTH,
  PARSE_CONCURRENCY,
  EMBEDDING_CONCURRENCY,
  EMBEDDING_TIMEOUT_MS,
  DB_WRITE_BATCH_SIZE,
  isFileSizeValid,
  isGraphSizeValid,
  withQueryTimeout,
  withTimeoutOr,
  isTraversalDepthValid,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_SHUTDOWN_HARD_MS,
  SHUTDOWN_GRACE_MS_ENV,
  SHUTDOWN_HARD_MS_ENV,
  getConfiguredShutdownGraceMs,
  getConfiguredShutdownHardMs,
} from './limits.js';

describe('shutdown timeout config', () => {
  it('returns documented defaults when env is unset', () => {
    delete process.env[SHUTDOWN_GRACE_MS_ENV];
    delete process.env[SHUTDOWN_HARD_MS_ENV];
    expect(getConfiguredShutdownGraceMs()).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    expect(getConfiguredShutdownHardMs()).toBe(DEFAULT_SHUTDOWN_HARD_MS);
  });

  it('reads integer overrides from env', () => {
    process.env[SHUTDOWN_GRACE_MS_ENV] = '1500';
    process.env[SHUTDOWN_HARD_MS_ENV] = '3000';
    expect(getConfiguredShutdownGraceMs()).toBe(1500);
    expect(getConfiguredShutdownHardMs()).toBe(3000);
    delete process.env[SHUTDOWN_GRACE_MS_ENV];
    delete process.env[SHUTDOWN_HARD_MS_ENV];
  });

  it('throws on a non-positive override', () => {
    process.env[SHUTDOWN_GRACE_MS_ENV] = '0';
    expect(() => getConfiguredShutdownGraceMs()).toThrow();
    delete process.env[SHUTDOWN_GRACE_MS_ENV];
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
