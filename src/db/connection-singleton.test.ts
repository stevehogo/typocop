/**
 * Bug condition exploration tests for LadybugDB connection singleton.
 *
 * These tests encode the EXPECTED (fixed) behavior. They MUST FAIL on
 * the current unfixed code, confirming the bug exists:
 *   - Database constructor is called twice for the same dbPath (should be once)
 *   - close() unconditionally closes the Database (should be reference-counted)
 *
 * Validates: Requirements 1.1, 1.2, 1.3
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Each `new Database()` returns a unique object so we can test identity.
const makeMockDatabase = (): Record<string, ReturnType<typeof vi.fn>> => ({
  init: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

const makeMockConnection = (): Record<string, ReturnType<typeof vi.fn>> => ({
  init: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
});

/** Tracks every Database instance created, keyed by the dbPath argument. */
const databaseInstances: Map<string, Array<Record<string, ReturnType<typeof vi.fn>>>> = new Map();

vi.mock("@ladybugdb/core", () => ({
  Database: vi.fn().mockImplementation(function (dbPath: string) {
    const instance = makeMockDatabase();
    const existing = databaseInstances.get(dbPath) ?? [];
    existing.push(instance);
    databaseInstances.set(dbPath, existing);
    return instance;
  }),
  Connection: vi.fn().mockImplementation(function () {
    return makeMockConnection();
  }),
}));

// Mock file-lock to avoid actual file operations in tests
vi.mock("./file-lock.js", () => ({
  acquireFileLock: vi.fn().mockResolvedValue({
    lockPath: "/tmp/test.ladybug.lock",
    release: vi.fn().mockResolvedValue(undefined),
  }),
  releaseFileLock: vi.fn().mockResolvedValue(undefined),
}));

import { Database, Connection } from "@ladybugdb/core";
import { createLadybugConnection, resetConnectionCache } from "./connection.js";
import { DatabaseConnectionError } from "./errors.js";

const MockDatabase = vi.mocked(Database);
const MockConnection = vi.mocked(Connection);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const instantSleep = vi.fn().mockResolvedValue(undefined);

/**
 * Arbitrary for valid dbPath strings — non-empty, no control chars.
 * Prefixed with /tmp/ to look like real paths.
 */
const dbPathArb = fc
  .stringMatching(/^[a-zA-Z0-9_-]+$/, { minLength: 1, maxLength: 30 })
  .map((s) => `/tmp/${s}.ladybug`);

// ─── Bug Condition Tests ──────────────────────────────────────────────────────

describe("Bug Condition: Shared Database for Same dbPath", () => {
  beforeEach(() => {
    resetConnectionCache();
    vi.clearAllMocks();
    databaseInstances.clear();
  });

  it("Property 1: for any dbPath, calling createLadybugConnection twice should share the same Database instance and call Database constructor exactly once", async () => {
    /**
     * Validates: Requirements 1.1, 1.2
     *
     * EXPECTED (fixed) behavior: two calls with the same dbPath share one
     * Database instance; Database constructor called once.
     *
     * CURRENT (buggy) behavior: Database constructor called twice, producing
     * two distinct instances → this test SHOULD FAIL on unfixed code.
     */
    await fc.assert(
      fc.asyncProperty(dbPathArb, async (dbPath) => {
        // Arrange
        resetConnectionCache();
        vi.clearAllMocks();
        databaseInstances.clear();

        // Act
        const conn1 = await createLadybugConnection(dbPath, instantSleep);
        const conn2 = await createLadybugConnection(dbPath, instantSleep);

        // Assert — same Database instance shared
        expect(conn1.database).toBe(conn2.database);

        // Assert — Database constructor called exactly once for this dbPath
        const instances = databaseInstances.get(dbPath) ?? [];
        expect(instances).toHaveLength(1);
      }),
      { numRuns: 20 },
    );
  });
});

describe("Bug Condition: Reference-Counted Close", () => {
  beforeEach(() => {
    resetConnectionCache();
    vi.clearAllMocks();
    databaseInstances.clear();
  });

  it("Property 2: for any dbPath with 2 open connections, closing the first should NOT close the underlying Database", async () => {
    /**
     * Validates: Requirements 1.3
     *
     * EXPECTED (fixed) behavior: close() on the first connection decrements
     * refCount but does NOT call database.close() while the second connection
     * is still open.
     *
     * CURRENT (buggy) behavior: close() unconditionally calls database.close(),
     * invalidating the second connection → this test SHOULD FAIL on unfixed code.
     */
    await fc.assert(
      fc.asyncProperty(dbPathArb, async (dbPath) => {
        // Arrange
        resetConnectionCache();
        vi.clearAllMocks();
        databaseInstances.clear();

        const conn1 = await createLadybugConnection(dbPath, instantSleep);
        const conn2 = await createLadybugConnection(dbPath, instantSleep);

        // Grab the Database instance(s) that were created for this dbPath
        const instances = databaseInstances.get(dbPath) ?? [];

        // Act — close the first connection only
        await conn1.close();

        // Assert — database.close() should NOT have been called on any instance
        // because the second connection is still open
        for (const db of instances) {
          expect(db.close).not.toHaveBeenCalled();
        }
      }),
      { numRuns: 20 },
    );
  });
});


// ─── Preservation Tests ───────────────────────────────────────────────────────

describe("Preservation: Cache-Miss Behavior", () => {
  beforeEach(() => {
    resetConnectionCache();
    vi.clearAllMocks();
    databaseInstances.clear();
  });

  it("Property 1: for any single dbPath (cache miss), createLadybugConnection creates a Database, calls init(), creates a Connection, calls init(), and returns object with database, connection, dbPath properties", async () => {
    /**
     * Validates: Requirements 3.1, 3.5
     *
     * On a cache miss (single call, fresh path), the function must:
     * - construct a Database with the dbPath
     * - call database.init()
     * - construct a Connection wrapping the database
     * - call connection.init()
     * - return { database, connection, dbPath }
     */
    await fc.assert(
      fc.asyncProperty(dbPathArb, async (dbPath) => {
        // Arrange
        resetConnectionCache();
        vi.clearAllMocks();
        databaseInstances.clear();

        // Act
        const conn = await createLadybugConnection(dbPath, instantSleep);

        // Assert — Database created with correct dbPath
        expect(MockDatabase).toHaveBeenCalledWith(dbPath);

        // Assert — Database.init() called
        const instances = databaseInstances.get(dbPath) ?? [];
        expect(instances).toHaveLength(1);
        expect(instances[0].init).toHaveBeenCalledOnce();

        // Assert — Connection created wrapping the database instance
        expect(MockConnection).toHaveBeenCalledWith(instances[0]);

        // Assert — returned object exposes database, connection, dbPath
        expect(conn).toHaveProperty("database");
        expect(conn).toHaveProperty("connection");
        expect(conn).toHaveProperty("dbPath");
        expect(conn.dbPath).toBe(dbPath);
        expect(conn.database).toBe(instances[0]);
      }),
      { numRuns: 20 },
    );
  });

  it("Property 2: for any two distinct dbPath values, separate Database instances are created", async () => {
    /**
     * Validates: Requirements 3.3
     *
     * Different dbPath values must produce separate Database instances —
     * no cross-path sharing.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(dbPathArb, dbPathArb).filter(([a, b]) => a !== b),
        async ([pathA, pathB]) => {
          // Arrange
          resetConnectionCache();
          vi.clearAllMocks();
          databaseInstances.clear();

          // Act
          const connA = await createLadybugConnection(pathA, instantSleep);
          const connB = await createLadybugConnection(pathB, instantSleep);

          // Assert — two separate Database instances
          const instancesA = databaseInstances.get(pathA) ?? [];
          const instancesB = databaseInstances.get(pathB) ?? [];
          expect(instancesA).toHaveLength(1);
          expect(instancesB).toHaveLength(1);
          expect(connA.database).not.toBe(connB.database);

          // Assert — Database constructor called twice (once per path)
          expect(MockDatabase).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("Property 3: when Database.init() fails all 3 attempts, DatabaseConnectionError is thrown with correct dbPath and cause", async () => {
    /**
     * Validates: Requirements 3.2
     *
     * When all retry attempts are exhausted, a DatabaseConnectionError
     * must be thrown carrying the dbPath and the underlying cause.
     */
    await fc.assert(
      fc.asyncProperty(dbPathArb, async (dbPath) => {
        // Arrange
        resetConnectionCache();
        vi.clearAllMocks();
        databaseInstances.clear();

        const cause = new Error("persistent failure");

        // Temporarily override Database mock to make init() reject
        const originalImpl = MockDatabase.getMockImplementation();
        MockDatabase.mockImplementation(function (path: string) {
          const instance = {
            init: vi.fn().mockRejectedValue(cause),
            close: vi.fn().mockResolvedValue(undefined),
          };
          const existing = databaseInstances.get(path) ?? [];
          existing.push(instance);
          databaseInstances.set(path, existing);
          return instance as ReturnType<typeof makeMockDatabase>;
        });

        try {
          // Act & Assert
          await expect(
            createLadybugConnection(dbPath, instantSleep),
          ).rejects.toThrow(DatabaseConnectionError);

          try {
            await createLadybugConnection(dbPath, instantSleep);
          } catch (err: unknown) {
            expect(err).toBeInstanceOf(DatabaseConnectionError);
            const connErr = err as DatabaseConnectionError;
            expect(connErr.dbPath).toBe(dbPath);
            expect(connErr.cause).toBe(cause);
          }
        } finally {
          // Restore original mock implementation
          if (originalImpl) {
            MockDatabase.mockImplementation(originalImpl);
          } else {
            MockDatabase.mockImplementation(function (path: string) {
              const instance = makeMockDatabase();
              const existing = databaseInstances.get(path) ?? [];
              existing.push(instance);
              databaseInstances.set(path, existing);
              return instance;
            });
          }
        }
      }),
      { numRuns: 20 },
    );
  });
});
