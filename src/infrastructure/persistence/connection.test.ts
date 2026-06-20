/**
 * Unit tests for LadybugDB connection manager.
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseConnectionError, DatabaseLockedError } from "./errors.js";

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

import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, Connection } from "@ladybugdb/core";
import { acquireFileLock } from "./file-lock.js";
import { createLadybugConnection, resetConnectionCache, isCorruptWalError } from "./connection.js";

const mockAcquireFileLock = vi.mocked(acquireFileLock);

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

describe("corrupt WAL self-heal", () => {
  beforeEach(() => {
    resetConnectionCache();
    vi.clearAllMocks();
    mockDatabaseInit.mockResolvedValue(undefined);
    mockConnectionInit.mockResolvedValue(undefined);
  });

  const corruptWalErr = (): Error =>
    new Error("Runtime exception: Corrupted wal file. Read out invalid WAL record type.");

  it("quarantines the WAL once on a corrupt-WAL error and succeeds on retry", async () => {
    mockDatabaseInit.mockRejectedValueOnce(corruptWalErr()).mockResolvedValueOnce(undefined);
    const quarantine = vi.fn().mockResolvedValue(true);

    const conn = await createLadybugConnection("/tmp/test.ladybug", instantSleep, {}, quarantine);

    expect(quarantine).toHaveBeenCalledTimes(1);
    expect(quarantine).toHaveBeenCalledWith("/tmp/test.ladybug");
    expect(MockDatabase).toHaveBeenCalledTimes(2);
    expect(conn.connection).toBe(mockConnectionInstance);
  });

  it("does NOT quarantine for a non-WAL error (e.g. locked)", async () => {
    mockDatabaseInit.mockRejectedValueOnce(new Error("locked")).mockResolvedValueOnce(undefined);
    const quarantine = vi.fn().mockResolvedValue(false);

    await createLadybugConnection("/tmp/test.ladybug", instantSleep, {}, quarantine);

    expect(quarantine).not.toHaveBeenCalled();
  });

  it("quarantines at most once even when every attempt is corrupt", async () => {
    mockDatabaseInit.mockRejectedValue(corruptWalErr());
    const quarantine = vi.fn().mockResolvedValue(true);

    await expect(
      createLadybugConnection("/tmp/test.ladybug", instantSleep, {}, quarantine),
    ).rejects.toThrow(DatabaseConnectionError);

    expect(quarantine).toHaveBeenCalledTimes(1);
  });

  it("default quarantine renames a real WAL file aside (fs-backed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "typocop-wal-"));
    const dbPath = join(dir, "db.ladybug");
    const walPath = `${dbPath}.wal`;
    await writeFile(walPath, "corrupt-bytes");
    // First attempt throws corrupt-WAL, second succeeds; no injected quarantine,
    // so the real defaultQuarantineWal runs against the temp WAL.
    mockDatabaseInit.mockRejectedValueOnce(corruptWalErr()).mockResolvedValueOnce(undefined);

    await createLadybugConnection(dbPath, instantSleep);

    await expect(access(walPath)).rejects.toThrow(); // renamed to a corrupt-bak sibling
    await rm(dir, { recursive: true, force: true });
  });
});

describe("isCorruptWalError", () => {
  it("matches LadybugDB corrupt-WAL messages", () => {
    expect(isCorruptWalError(new Error("Corrupted wal file. Read out invalid WAL record type."))).toBe(true);
    expect(isCorruptWalError(new Error("read out invalid WAL record"))).toBe(true);
  });
  it("does not match unrelated errors", () => {
    expect(isCorruptWalError(new Error("locked"))).toBe(false);
    expect(isCorruptWalError(new Error("connection refused"))).toBe(false);
    expect(isCorruptWalError("some string")).toBe(false);
  });
});

describe("lock contention surfaces an actionable error (Phase D)", () => {
  beforeEach(() => {
    resetConnectionCache();
    vi.clearAllMocks();
  });

  it("propagates DatabaseLockedError from acquireFileLock without wrapping it", async () => {
    const lockErr = new DatabaseLockedError("/tmp/test.ladybug", 30000, new Error("ELOCKED"), 4242, true);
    mockAcquireFileLock.mockRejectedValueOnce(lockErr);

    await expect(
      createLadybugConnection("/tmp/test.ladybug", instantSleep),
    ).rejects.toBe(lockErr);

    // The DB retry loop must never run when the lock could not be acquired.
    expect(MockDatabase).not.toHaveBeenCalled();
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
