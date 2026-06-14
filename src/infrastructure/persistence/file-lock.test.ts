/**
 * Unit tests for the database file lock (resilience Phase D):
 * - configurable stale/retries (defaults preserved),
 * - actionable DatabaseLockedError on contention with pid-liveness enrichment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { DatabaseLockedError } from "./errors.js";
import {
  DEFAULT_DB_LOCK_RETRIES,
  DEFAULT_DB_LOCK_STALE_MS,
} from "../../platform/utils/limits.js";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockLock = vi.fn();

vi.mock("proper-lockfile", () => ({
  lock: (...args: unknown[]) => mockLock(...args),
}));

// In-memory fs so writeFile/readFileSync model the lock payload without disk.
const fileContents = new Map<string, string>();

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn(async (path: string, data: string, opts?: { flag?: string }) => {
    if (opts?.flag === "a") {
      fileContents.set(path, (fileContents.get(path) ?? "") + data);
      return;
    }
    fileContents.set(path, data);
  }),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn((path: string) => {
    const content = fileContents.get(path);
    if (content === undefined) {
      const err: NodeJS.ErrnoException = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    }
    return content;
  }),
  rmSync: vi.fn(),
}));

import { acquireFileLock } from "./file-lock.js";

function elocked(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("Lock file is already being held");
  err.code = "ELOCKED";
  return err;
}

describe("acquireFileLock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileContents.clear();
    delete process.env.LADYBUG_DB_LOCK_STALE_MS;
    delete process.env.LADYBUG_DB_LOCK_RETRIES;
  });

  it("uses default stale/retries when no options or env are set", async () => {
    mockLock.mockResolvedValue(vi.fn().mockResolvedValue(undefined));

    await acquireFileLock("/tmp/db.ladybug");

    expect(mockLock).toHaveBeenCalledWith("/tmp/db.ladybug.lock", {
      retries: DEFAULT_DB_LOCK_RETRIES,
      stale: DEFAULT_DB_LOCK_STALE_MS,
    });
  });

  it("honors explicit stale/retries options", async () => {
    mockLock.mockResolvedValue(vi.fn().mockResolvedValue(undefined));

    await acquireFileLock("/tmp/db.ladybug", { staleMs: 1234, retries: 2 });

    expect(mockLock).toHaveBeenCalledWith("/tmp/db.ladybug.lock", {
      retries: 2,
      stale: 1234,
    });
  });

  it("honors env overrides for stale/retries", async () => {
    process.env.LADYBUG_DB_LOCK_STALE_MS = "7000";
    process.env.LADYBUG_DB_LOCK_RETRIES = "3";
    mockLock.mockResolvedValue(vi.fn().mockResolvedValue(undefined));

    await acquireFileLock("/tmp/db.ladybug");

    expect(mockLock).toHaveBeenCalledWith("/tmp/db.ladybug.lock", {
      retries: 3,
      stale: 7000,
    });
  });

  it("writes the owning pid into the lock payload on acquire", async () => {
    mockLock.mockResolvedValue(vi.fn().mockResolvedValue(undefined));

    await acquireFileLock("/tmp/db.ladybug");

    expect(fileContents.get("/tmp/db.ladybug.lock")).toBe(`${process.pid}\n`);
  });

  it("throws an actionable DatabaseLockedError on contention (message names dbPath + stale hint)", async () => {
    mockLock.mockRejectedValue(elocked());
    // No prior pid payload present.

    await expect(
      acquireFileLock("/data/app.ladybug", { staleMs: 30000 }),
    ).rejects.toThrow(DatabaseLockedError);

    try {
      await acquireFileLock("/data/app.ladybug", { staleMs: 30000 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseLockedError);
      const locked = err as DatabaseLockedError;
      expect(locked.dbPath).toBe("/data/app.ladybug");
      expect(locked.message).toContain("/data/app.ladybug");
      expect(locked.message).toContain("30 s");
      expect(locked.staleMs).toBe(30000);
    }
  });

  it("reports the holder as live when its recorded pid is alive", async () => {
    // Pre-seed a holder pid into the lock payload, then fail acquisition.
    fileContents.set("/data/app.ladybug.lock", "4242\n");
    mockLock.mockRejectedValue(elocked());
    const isPidAlive = vi.fn().mockReturnValue(true);

    try {
      await acquireFileLock("/data/app.ladybug", { staleMs: 30000, isPidAlive });
      expect.fail("should have thrown");
    } catch (err) {
      const locked = err as DatabaseLockedError;
      expect(isPidAlive).toHaveBeenCalledWith(4242);
      expect(locked.holderPid).toBe(4242);
      expect(locked.holderAlive).toBe(true);
      expect(locked.message).toContain("live process");
      expect(locked.message).toContain("4242");
    }
  });

  it("reports the holder as crashed/dead when its recorded pid is not alive", async () => {
    fileContents.set("/data/app.ladybug.lock", "999999\n");
    mockLock.mockRejectedValue(elocked());
    const isPidAlive = vi.fn().mockReturnValue(false);

    try {
      await acquireFileLock("/data/app.ladybug", { staleMs: 20000, isPidAlive });
      expect.fail("should have thrown");
    } catch (err) {
      const locked = err as DatabaseLockedError;
      expect(locked.holderAlive).toBe(false);
      expect(locked.message).toContain("crashed");
      expect(locked.message).toContain("~20 s");
    }
  });

  it("re-throws non-ELOCKED errors unchanged", async () => {
    const boom = new Error("disk on fire");
    mockLock.mockRejectedValue(boom);

    await expect(acquireFileLock("/tmp/db.ladybug")).rejects.toBe(boom);
  });
});
