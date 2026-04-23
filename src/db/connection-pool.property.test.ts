/**
 * Property-based tests for ConnectionPool using fast-check.
 * Validates: Requirements 3.1, 3.2, 4.2, 10.1
 * Correctness Properties: 1 (No Leaks), 2 (Size Invariant), 5 (Eviction Min), 10 (FIFO)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";

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
import type { PooledConnection } from "./pool-types.js";

// ─── Property Tests ───────────────────────────────────────────────────────────

describe("ConnectionPool — Property-Based Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectionQuery.mockResolvedValue(undefined);
  });

  /**
   * **Validates: Requirements 10.1**
   * Property 3 (No Connection Leaks):
   * stats().totalConnections === stats().activeConnections + stats().idleConnections
   * for any sequence of acquire/release operations.
   */
  it("13.1 total === active + idle for any acquire/release sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 20 }),
        async (ops) => {
          const pool = await ConnectionPool.create("/tmp/pbt.ladybug", {
            minConnections: 1,
            maxConnections: 10,
          });
          const held: PooledConnection[] = [];

          for (const shouldAcquire of ops) {
            if (shouldAcquire && held.length < 10) {
              held.push(await pool.acquire());
            } else if (!shouldAcquire && held.length > 0) {
              await pool.release(held.pop()!);
            }

            const s = pool.stats();
            expect(s.totalConnections).toBe(
              s.activeConnections + s.idleConnections,
            );
          }

          // Release all remaining
          for (const c of held) await pool.release(c);
          const final = pool.stats();
          expect(final.totalConnections).toBe(
            final.activeConnections + final.idleConnections,
          );

          await pool.drain();
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 1.1, 1.2**
   * Property 1 (Pool Size Invariant):
   * stats().totalConnections stays within [minConnections, maxConnections]
   * for any operation sequence after warmup.
   */
  it("13.2 totalConnections within [min, max] after warmup", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 4, max: 8 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 15 }),
        async (min, max, ops) => {
          const pool = await ConnectionPool.create("/tmp/pbt.ladybug", {
            minConnections: min,
            maxConnections: max,
          });
          const held: PooledConnection[] = [];

          // After create, pool is warmed up — check invariant
          const warmup = pool.stats();
          expect(warmup.totalConnections).toBeGreaterThanOrEqual(min);
          expect(warmup.totalConnections).toBeLessThanOrEqual(max);

          for (const shouldAcquire of ops) {
            if (shouldAcquire && held.length < max) {
              held.push(await pool.acquire());
            } else if (!shouldAcquire && held.length > 0) {
              await pool.release(held.pop()!);
            }

            const s = pool.stats();
            expect(s.totalConnections).toBeGreaterThanOrEqual(min);
            expect(s.totalConnections).toBeLessThanOrEqual(max);
          }

          for (const c of held) await pool.release(c);
          await pool.drain();
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 3.2**
   * Property 10 (FIFO Waiter Ordering):
   * For any N waiters, connections are handed out in order of waiting.
   */
  it("13.3 FIFO ordering for N waiters", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        async (n) => {
          const pool = await ConnectionPool.create("/tmp/pbt.ladybug", {
            minConnections: 1,
            maxConnections: 1,
            acquireTimeoutMs: 5000,
          });

          // Saturate the pool
          const first = await pool.acquire();

          // Queue N waiters
          const order: number[] = [];
          const waiters = Array.from({ length: n }, (_, i) =>
            pool.acquire().then((conn) => {
              order.push(i);
              return conn;
            }),
          );

          // Release one at a time, each should go to the next waiter in FIFO order
          let current = first;
          for (let i = 0; i < n; i++) {
            await pool.release(current);
            current = await waiters[i];
          }

          expect(order).toEqual(Array.from({ length: n }, (_, i) => i));

          await pool.release(current);
          await pool.drain();
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 4.2**
   * Property 5 (Idle Eviction Respects Minimum):
   * Idle eviction never reduces totalConnections below minConnections.
   */
  it("13.4 eviction never reduces below minConnections", async () => {
    vi.useFakeTimers();

    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 4 }),
          fc.integer({ min: 4, max: 8 }),
          fc.integer({ min: 1, max: 5 }),
          async (min, max, extraAcquires) => {
            const pool = await ConnectionPool.create("/tmp/pbt.ladybug", {
              minConnections: min,
              maxConnections: max,
              idleTimeoutMs: 1000,
              healthCheckIntervalMs: 500,
            });

            // Acquire extra connections beyond min, then release all to idle
            const held: PooledConnection[] = [];
            const toAcquire = Math.min(extraAcquires, max);
            for (let i = 0; i < toAcquire; i++) {
              held.push(await pool.acquire());
            }
            for (const c of held) await pool.release(c);

            // Advance time past idle timeout to trigger eviction
            vi.advanceTimersByTime(1500);

            const s = pool.stats();
            expect(s.totalConnections).toBeGreaterThanOrEqual(min);

            await pool.drain();
          },
        ),
        { numRuns: 50 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
