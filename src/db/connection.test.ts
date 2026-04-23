/**
 * Unit tests for LadybugDB connection manager.
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseConnectionError } from "./errors.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockDatabaseInit = vi.fn().mockResolvedValue(undefined);
const mockDatabaseClose = vi.fn().mockResolvedValue(undefined);
const mockConnectionInit = vi.fn().mockResolvedValue(undefined);
const mockConnectionClose = vi.fn().mockResolvedValue(undefined);

const mockDatabaseInstance = { init: mockDatabaseInit, close: mockDatabaseClose };
const mockConnectionInstance = { init: mockConnectionInit, close: mockConnectionClose };

vi.mock("@ladybugdb/core", () => ({
  Database: vi.fn().mockImplementation(function () {
    return mockDatabaseInstance;
  }),
  Connection: vi.fn().mockImplementation(function () {
    return mockConnectionInstance;
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

const MockDatabase = vi.mocked(Database);
const MockConnection = vi.mocked(Connection);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Instant sleep — no real delays in tests. */
const instantSleep = vi.fn().mockResolvedValue(undefined);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createLadybugConnection", () => {
  beforeEach(() => {
    resetConnectionCache();
    vi.clearAllMocks();
    mockDatabaseInit.mockResolvedValue(undefined);
    mockConnectionInit.mockResolvedValue(undefined);
  });

  it("should create Database with dbPath and Connection wrapping it (Req 6.1)", async () => {
    const conn = await createLadybugConnection("/tmp/test.ladybug", instantSleep);

    expect(MockDatabase).toHaveBeenCalledWith("/tmp/test.ladybug");
    expect(mockDatabaseInit).toHaveBeenCalledOnce();
    expect(MockConnection).toHaveBeenCalledWith(mockDatabaseInstance);
    expect(mockConnectionInit).toHaveBeenCalledOnce();
    expect(conn.dbPath).toBe("/tmp/test.ladybug");
  });

  it("should expose database and connection on the returned connection", async () => {
    const conn = await createLadybugConnection("/tmp/test.ladybug", instantSleep);

    expect(conn.database).toBe(mockDatabaseInstance);
    expect(conn.connection).toBe(mockConnectionInstance);
  });

  it("should close both connection and database on close() (Req 6.3)", async () => {
    const conn = await createLadybugConnection("/tmp/test.ladybug", instantSleep);

    await conn.close();

    expect(mockConnectionClose).toHaveBeenCalledOnce();
    expect(mockDatabaseClose).toHaveBeenCalledOnce();
  });

  it("should succeed on first attempt without sleeping", async () => {
    await createLadybugConnection("/tmp/test.ladybug", instantSleep);

    expect(instantSleep).not.toHaveBeenCalled();
  });

  describe("retry with exponential backoff (Req 6.2)", () => {
    it("should retry and succeed on second attempt with 200ms delay", async () => {
      mockDatabaseInit
        .mockRejectedValueOnce(new Error("locked"))
        .mockResolvedValueOnce(undefined);

      const conn = await createLadybugConnection("/tmp/test.ladybug", instantSleep);

      expect(MockDatabase).toHaveBeenCalledTimes(2);
      expect(instantSleep).toHaveBeenCalledTimes(1);
      expect(instantSleep).toHaveBeenCalledWith(200);
      expect(conn.connection).toBe(mockConnectionInstance);
    });

    it("should retry and succeed on third attempt with 200ms then 400ms delays", async () => {
      mockDatabaseInit
        .mockRejectedValueOnce(new Error("locked"))
        .mockRejectedValueOnce(new Error("locked again"))
        .mockResolvedValueOnce(undefined);

      const conn = await createLadybugConnection("/tmp/test.ladybug", instantSleep);

      expect(MockDatabase).toHaveBeenCalledTimes(3);
      expect(instantSleep).toHaveBeenCalledTimes(2);
      expect(instantSleep).toHaveBeenNthCalledWith(1, 200);
      expect(instantSleep).toHaveBeenNthCalledWith(2, 400);
      expect(conn.connection).toBe(mockConnectionInstance);
    });

    it("should also retry when connection init fails", async () => {
      mockConnectionInit
        .mockRejectedValueOnce(new Error("connection init failed"))
        .mockResolvedValueOnce(undefined);

      const conn = await createLadybugConnection("/tmp/test.ladybug", instantSleep);

      expect(MockDatabase).toHaveBeenCalledTimes(2);
      expect(MockConnection).toHaveBeenCalledTimes(2);
      expect(instantSleep).toHaveBeenCalledWith(200);
      expect(conn.connection).toBe(mockConnectionInstance);
    });
  });

  describe("DatabaseConnectionError after exhausted retries (Req 6.4)", () => {
    it("should throw DatabaseConnectionError after 3 failed attempts", async () => {
      const cause = new Error("persistent failure");
      mockDatabaseInit.mockRejectedValue(cause);

      await expect(
        createLadybugConnection("/tmp/test.ladybug", instantSleep),
      ).rejects.toThrow(DatabaseConnectionError);
    });

    it("should include dbPath and cause in the error", async () => {
      const cause = new Error("file corrupted");
      mockDatabaseInit.mockRejectedValue(cause);

      try {
        await createLadybugConnection("/data/db.ladybug", instantSleep);
        expect.fail("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(DatabaseConnectionError);
        const connErr = err as DatabaseConnectionError;
        expect(connErr.dbPath).toBe("/data/db.ladybug");
        expect(connErr.cause).toBe(cause);
        expect(connErr.message).toContain("/data/db.ladybug");
      }
    });

    it("should attempt exactly 3 times before throwing", async () => {
      mockDatabaseInit.mockRejectedValue(new Error("fail"));

      await expect(
        createLadybugConnection("/tmp/test.ladybug", instantSleep),
      ).rejects.toThrow(DatabaseConnectionError);

      expect(MockDatabase).toHaveBeenCalledTimes(3);
    });

    it("should use exponential backoff delays: 200ms, 400ms (no delay after last attempt)", async () => {
      mockDatabaseInit.mockRejectedValue(new Error("fail"));

      await expect(
        createLadybugConnection("/tmp/test.ladybug", instantSleep),
      ).rejects.toThrow();

      expect(instantSleep).toHaveBeenCalledTimes(2);
      expect(instantSleep).toHaveBeenNthCalledWith(1, 200);
      expect(instantSleep).toHaveBeenNthCalledWith(2, 400);
    });
  });
});

describe("DatabaseConnectionError", () => {
  it("should have correct name property", () => {
    const err = new DatabaseConnectionError("/tmp/db", new Error("cause"));
    expect(err.name).toBe("DatabaseConnectionError");
  });

  it("should be an instance of Error", () => {
    const err = new DatabaseConnectionError("/tmp/db", new Error("cause"));
    expect(err).toBeInstanceOf(Error);
  });

  it("should include dbPath in message", () => {
    const err = new DatabaseConnectionError("/my/path.ladybug", null);
    expect(err.message).toContain("/my/path.ladybug");
  });

  it("should preserve non-Error cause values", () => {
    const err = new DatabaseConnectionError("/tmp/db", "string cause");
    expect(err.cause).toBe("string cause");
  });
});
