import { describe, it, expect, vi } from 'vitest';
import {
  MAX_FILE_SIZE_BYTES,
  MAX_GRAPH_SIZE_NODES,
  QUERY_TIMEOUT_MS,
  MAX_TRAVERSAL_DEPTH,
  isFileSizeValid,
  isGraphSizeValid,
  withQueryTimeout,
  isTraversalDepthValid,
} from './limits.js';

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
