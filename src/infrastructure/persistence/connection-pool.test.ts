/**
 * Unit tests for ConnectionPool — create, stats, drain.
 * Requirements: 1.1, 1.2, 6.2, 10.1
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockConnectionInit = vi.fn().mockResolvedValue(undefined);
const mockConnectionClose = vi.fn().mockResolvedValue(undefined);
const mockConnectionQuery = vi.fn().mockResolvedValue(undefined);

vi.mock("@ladybugdb/core", () => {
  class MockDatabase {
    async init(): Promise<void> {}
    async close(): Promise<void> {}
  }
  class MockConnection {
    init = mockConnectionInit;
    close = mockConnectionClose;
    query = mockConnectionQuery;
  }
  return { Database: MockDatabase, Connection: MockConnection };
});

const mockLadybugClose = vi.fn().mockResolvedValue(undefined);

vi.mock("./connection.js", () => ({
  createLadybugConnection: vi.fn().mockImplementation((dbPath: string) =>
    Promise.resolve({
      connection: {
        init: mockConnectionInit,
        close: mockConnectionClose,
        query: mockConnectionQuery,
      },
      database: new (vi.fn())(),
      dbPath,
      close: mockLadybugClose,
    }),
  ),
}));

import { ConnectionPool } from "./connection-pool.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ConnectionPool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionQuery.mockResolvedValue(undefined);
  });

  describe("create()", () => {
    it("should create pool with default config (Req 1.1)", async () => {
      const pool = await ConnectionPool.create("/tmp/test.ladybug");
      const s = pool.stats();

      expect(s.dbPath).toBe("/tmp/test.ladybug");
      expect(s.idleConnections).toBe(1); // default minConnections = 1
      expect(s.activeConnections).toBe(0);
      expect(s.totalConnections).toBe(1);
      expect(s.waitingRequests).toBe(0);

      await pool.drain();
    });

    it("should create pool with custom config overrides (Req 1.1)", async () => {
      const pool = await ConnectionPool.create("/tmp/test.ladybug", {
        minConnections: 2,
        maxConnections: 10,
      });
      const s = pool.stats();

      expect(s.idleConnections).toBe(2);
      expect(s.totalConnections).toBe(2);

      await pool.drain();
    });

    it("should reject maxConnections < 1 (Req 1.2)", async () => {
      await expect(
        ConnectionPool.create("/tmp/test.ladybug", { maxConnections: 0 }),
      ).rejects.toThrow(/maxConnections must be >= 1/);
    });

    it("should reject minConnections < 0 (Req 1.2)", async () => {
      await expect(
        ConnectionPool.create("/tmp/test.ladybug", { minConnections: -1 }),
      ).rejects.toThrow(/minConnections must be >= 0/);
    });

    it("should reject minConnections > maxConnections (Req 1.2)", async () => {
      await expect(
        ConnectionPool.create("/tmp/test.ladybug", {
          minConnections: 10,
          maxConnections: 2,
        }),
      ).rejects.toThrow(/minConnections.*must be <= maxConnections/);
    });

    it("should reject acquireTimeoutMs <= 0 (Req 1.2)", async () => {
      await expect(
        ConnectionPool.create("/tmp/test.ladybug", { acquireTimeoutMs: 0 }),
      ).rejects.toThrow(/acquireTimeoutMs must be > 0/);
    });

    it("should reject idleTimeoutMs <= 0 (Req 1.2)", async () => {
      await expect(
        ConnectionPool.create("/tmp/test.ladybug", { idleTimeoutMs: -5 }),
      ).rejects.toThrow(/idleTimeoutMs must be > 0/);
    });
  });

  describe("stats()", () => {
    it("should return accurate counts (Req 10.1)", async () => {
      const pool = await ConnectionPool.create("/tmp/test.ladybug", {
        minConnections: 1,
        maxConnections: 3,
      });

      const s1 = pool.stats();
      expect(s1.totalConnections).toBe(s1.activeConnections + s1.idleConnections);
      expect(s1.idleConnections).toBe(1);
      expect(s1.activeConnections).toBe(0);

      const conn = await pool.acquire();
      const s2 = pool.stats();
      expect(s2.activeConnections).toBe(1);
      expect(s2.idleConnections).toBe(0);
      expect(s2.totalConnections).toBe(1);

      await pool.release(conn);
      const s3 = pool.stats();
      expect(s3.activeConnections).toBe(0);
      expect(s3.idleConnections).toBe(1);

      await pool.drain();
    });
  });

  describe("drain()", () => {
    it("should close all idle connections and reject new acquires (Req 6.2)", async () => {
      const pool = await ConnectionPool.create("/tmp/test.ladybug", {
        minConnections: 2,
        maxConnections: 5,
      });

      expect(pool.stats().idleConnections).toBe(2);

      await pool.drain();

      expect(pool.stats().totalConnections).toBe(0);
      await expect(pool.acquire()).rejects.toThrow(/drained/);
    });

    it("should wait for active connections before completing drain (Req 6.2)", async () => {
      const pool = await ConnectionPool.create("/tmp/test.ladybug");
      const conn = await pool.acquire();

      let drained = false;
      const drainPromise = pool.drain().then(() => {
        drained = true;
      });

      // drain should not resolve while connection is active
      await new Promise((r) => setTimeout(r, 20));
      expect(drained).toBe(false);

      await pool.release(conn);
      await drainPromise;
      expect(drained).toBe(true);
      expect(pool.stats().totalConnections).toBe(0);
    });
  });
});
