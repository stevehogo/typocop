/**
 * Unit tests for ConnectionPool — acquire behavior.
 * Requirements: 2.1, 2.2, 2.3, 2.4, 5.1
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
import { PoolExhaustedError } from "./errors.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ConnectionPool — acquire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionQuery.mockResolvedValue(undefined);
  });

  it("should return idle connection when available (Req 2.1)", async () => {
    const pool = await ConnectionPool.create("/tmp/test.ladybug", {
      minConnections: 1,
      maxConnections: 3,
    });

    expect(pool.stats().idleConnections).toBe(1);

    const conn = await pool.acquire();
    expect(conn).toBeDefined();
    expect(conn.dbPath).toBe("/tmp/test.ladybug");
    expect(pool.stats().activeConnections).toBe(1);
    expect(pool.stats().idleConnections).toBe(0);

    await pool.release(conn);
    await pool.drain();
  });

  it("should create new connection when idle empty and below max (Req 2.2)", async () => {
    const pool = await ConnectionPool.create("/tmp/test.ladybug", {
      minConnections: 1,
      maxConnections: 3,
    });

    // Acquire the pre-warmed idle connection
    const conn1 = await pool.acquire();
    expect(pool.stats().idleConnections).toBe(0);

    // This should create a new connection (below max)
    const conn2 = await pool.acquire();
    expect(pool.stats().activeConnections).toBe(2);
    expect(pool.stats().totalConnections).toBe(2);

    await pool.release(conn1);
    await pool.release(conn2);
    await pool.drain();
  });

  it("should throw PoolExhaustedError on timeout (Req 2.3)", async () => {
    const pool = await ConnectionPool.create("/tmp/test.ladybug", {
      minConnections: 1,
      maxConnections: 1,
      acquireTimeoutMs: 50,
    });

    // Acquire the only connection
    const conn = await pool.acquire();

    // Next acquire should timeout
    await expect(pool.acquire()).rejects.toThrow(PoolExhaustedError);

    await pool.release(conn);
    await pool.drain();
  });

  it("should include dbPath and timeoutMs in PoolExhaustedError (Req 2.3)", async () => {
    const pool = await ConnectionPool.create("/tmp/test.ladybug", {
      minConnections: 1,
      maxConnections: 1,
      acquireTimeoutMs: 50,
    });

    const conn = await pool.acquire();

    try {
      await pool.acquire();
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PoolExhaustedError);
      const pErr = err as PoolExhaustedError;
      expect(pErr.dbPath).toBe("/tmp/test.ladybug");
      expect(pErr.timeoutMs).toBe(50);
    }

    await pool.release(conn);
    await pool.drain();
  });

  it("should throw on drained pool (Req 2.4)", async () => {
    const pool = await ConnectionPool.create("/tmp/test.ladybug");
    await pool.drain();

    await expect(pool.acquire()).rejects.toThrow(/drained/);
  });

  it("should discard unhealthy idle connections (Req 5.1)", async () => {
    const pool = await ConnectionPool.create("/tmp/test.ladybug", {
      minConnections: 1,
      maxConnections: 3,
    });

    // Make health check fail for the first call, then succeed for new connection
    let callCount = 0;
    mockConnectionQuery.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("unhealthy"));
      return Promise.resolve(undefined);
    });

    // The idle connection should be discarded, a new one created
    const conn = await pool.acquire();
    expect(conn).toBeDefined();
    expect(pool.stats().activeConnections).toBe(1);

    await pool.release(conn);
    await pool.drain();
  });
});
