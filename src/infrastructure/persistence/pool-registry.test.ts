/**
 * Unit tests for pool-registry module.
 * Requirements: 7.1
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockDrain = vi.fn().mockResolvedValue(undefined);
const mockAcquire = vi.fn();
const mockRelease = vi.fn();
const mockStats = vi.fn();

function createMockPool(): {
  drain: typeof mockDrain;
  acquire: typeof mockAcquire;
  release: typeof mockRelease;
  stats: typeof mockStats;
} {
  return {
    drain: vi.fn().mockResolvedValue(undefined),
    acquire: mockAcquire,
    release: mockRelease,
    stats: mockStats,
  };
}

const mockCreate = vi.fn();

vi.mock("./connection-pool.js", () => ({
  ConnectionPool: {
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

import {
  getPool,
  removePool,
  drainAllPools,
  resetPoolRegistry,
} from "./pool-registry.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("pool-registry", () => {
  beforeEach(() => {
    resetPoolRegistry();
    vi.clearAllMocks();
  });

  describe("getPool", () => {
    it("should create a new pool when none exists for dbPath", async () => {
      const pool = createMockPool();
      mockCreate.mockResolvedValueOnce(pool);

      const result = await getPool("/tmp/test.ladybug");

      expect(mockCreate).toHaveBeenCalledWith("/tmp/test.ladybug", undefined);
      expect(result).toBe(pool);
    });

    it("should return existing pool for same dbPath", async () => {
      const pool = createMockPool();
      mockCreate.mockResolvedValueOnce(pool);

      const first = await getPool("/tmp/test.ladybug");
      const second = await getPool("/tmp/test.ladybug");

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    });

    it("should create separate pools for different dbPaths", async () => {
      const poolA = createMockPool();
      const poolB = createMockPool();
      mockCreate.mockResolvedValueOnce(poolA).mockResolvedValueOnce(poolB);

      const a = await getPool("/tmp/a.ladybug");
      const b = await getPool("/tmp/b.ladybug");

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(a).not.toBe(b);
    });

    it("should forward config to ConnectionPool.create", async () => {
      const pool = createMockPool();
      mockCreate.mockResolvedValueOnce(pool);
      const config = { maxConnections: 10, acquireTimeoutMs: 3000 };

      await getPool("/tmp/test.ladybug", config);

      expect(mockCreate).toHaveBeenCalledWith("/tmp/test.ladybug", config);
    });

    it("should ignore config on subsequent calls for same dbPath", async () => {
      const pool = createMockPool();
      mockCreate.mockResolvedValueOnce(pool);

      await getPool("/tmp/test.ladybug", { maxConnections: 10 });
      const second = await getPool("/tmp/test.ladybug", { maxConnections: 20 });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(second).toBe(pool);
    });
  });

  describe("removePool", () => {
    it("should drain and remove an existing pool", async () => {
      const pool = createMockPool();
      mockCreate.mockResolvedValueOnce(pool);

      await getPool("/tmp/test.ladybug");
      await removePool("/tmp/test.ladybug");

      expect(pool.drain).toHaveBeenCalledOnce();

      // After removal, getPool should create a new pool
      const newPool = createMockPool();
      mockCreate.mockResolvedValueOnce(newPool);
      const result = await getPool("/tmp/test.ladybug");
      expect(result).toBe(newPool);
    });

    it("should be a no-op for non-existent dbPath", async () => {
      await expect(removePool("/tmp/nonexistent.ladybug")).resolves.toBeUndefined();
    });
  });

  describe("drainAllPools", () => {
    it("should drain all registered pools", async () => {
      const poolA = createMockPool();
      const poolB = createMockPool();
      mockCreate.mockResolvedValueOnce(poolA).mockResolvedValueOnce(poolB);

      await getPool("/tmp/a.ladybug");
      await getPool("/tmp/b.ladybug");
      await drainAllPools();

      expect(poolA.drain).toHaveBeenCalledOnce();
      expect(poolB.drain).toHaveBeenCalledOnce();
    });

    it("should clear the registry after draining", async () => {
      const pool = createMockPool();
      mockCreate.mockResolvedValueOnce(pool);

      await getPool("/tmp/test.ladybug");
      await drainAllPools();

      // Next getPool should create a new pool
      const newPool = createMockPool();
      mockCreate.mockResolvedValueOnce(newPool);
      const result = await getPool("/tmp/test.ladybug");
      expect(result).toBe(newPool);
    });

    it("should be a no-op when registry is empty", async () => {
      await expect(drainAllPools()).resolves.toBeUndefined();
    });
  });

  describe("resetPoolRegistry", () => {
    it("should clear the registry without draining", async () => {
      const pool = createMockPool();
      mockCreate.mockResolvedValueOnce(pool);

      await getPool("/tmp/test.ladybug");
      resetPoolRegistry();

      expect(pool.drain).not.toHaveBeenCalled();

      // Next getPool should create a new pool
      const newPool = createMockPool();
      mockCreate.mockResolvedValueOnce(newPool);
      const result = await getPool("/tmp/test.ladybug");
      expect(result).toBe(newPool);
    });
  });
});
