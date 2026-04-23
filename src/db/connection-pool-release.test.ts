/**
 * Unit tests for ConnectionPool — release, eviction.
 * Requirements: 3.1, 3.2, 3.3, 4.1, 4.2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

describe("ConnectionPool — release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionQuery.mockResolvedValue(undefined);
  });

  it("should return connection to idle (Req 3.1)", async () => {
    const pool = await ConnectionPool.create("/tmp/test.ladybug");
    const conn = await pool.acquire();

    expect(pool.stats().activeConnections).toBe(1);
    expect(pool.stats().idleConnections).toBe(0);

    await pool.release(conn);

    expect(pool.stats().activeConnections).toBe(0);
    expect(pool.stats().idleConnections).toBe(1);

    await pool.drain();
  });

  it("should hand off to waiting acquirer in FIFO order (Req 3.2)", async () => {
    const pool = await ConnectionPool.create("/tmp/test.ladybug", {
      minConnections: 1,
      maxConnections: 1,
      acquireTimeoutMs: 2000,
    });

    const conn1 = await pool.acquire();

    // Queue two waiters
    const order: number[] = [];
    const waiter1 = pool.acquire().then((c) => {
      order.push(1);
      return c;
    });
    const waiter2 = pool.acquire().then((c) => {
      order.push(2);
      return c;
    });

    // Release — should go to waiter1 (FIFO)
    await pool.release(conn1);
    const resolved1 = await waiter1;

    // Release again — should go to waiter2
    await pool.release(resolved1);
    const resolved2 = await waiter2;

    expect(order).toEqual([1, 2]);

    // Connection should not be in idle (handed directly to waiter)
    await pool.release(resolved2);
    await pool.drain();
  });

  it("should be idempotent on double-release (Req 3.3)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pool = await ConnectionPool.create("/tmp/test.ladybug");
    const conn = await pool.acquire();

    await pool.release(conn);
    await pool.release(conn); // double release — should be no-op

    expect(pool.stats().idleConnections).toBe(1);
    expect(pool.stats().activeConnections).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("already released"),
    );

    warnSpy.mockRestore();
    await pool.drain();
  });
});

describe("ConnectionPool — idle eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockConnectionQuery.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should evict idle connections after idleTimeoutMs (Req 4.1)", async () => {
    const pool = await ConnectionPool.create("/tmp/test.ladybug", {
      minConnections: 0,
      maxConnections: 3,
      idleTimeoutMs: 1000,
      healthCheckIntervalMs: 500,
    });

    // Acquire and release to get a connection in idle
    const conn = await pool.acquire();
    await pool.release(conn);
    expect(pool.stats().idleConnections).toBe(1);

    // Advance past idle timeout + health check interval
    vi.advanceTimersByTime(1500);

    expect(pool.stats().idleConnections).toBe(0);
    expect(pool.stats().totalConnections).toBe(0);

    await pool.drain();
  });

  it("should respect minConnections during eviction (Req 4.2)", async () => {
    const pool = await ConnectionPool.create("/tmp/test.ladybug", {
      minConnections: 1,
      maxConnections: 3,
      idleTimeoutMs: 1000,
      healthCheckIntervalMs: 500,
    });

    // Pool starts with 1 idle (minConnections)
    expect(pool.stats().idleConnections).toBe(1);

    // Advance past idle timeout
    vi.advanceTimersByTime(1500);

    // Should NOT evict below minConnections
    expect(pool.stats().totalConnections).toBeGreaterThanOrEqual(1);

    await pool.drain();
  });
});
