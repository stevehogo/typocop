/**
 * File-based locking for cross-process database access serialization.
 * Uses OS-level exclusive locks to ensure only one process accesses the database at a time.
 */

import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import * as lockfile from "proper-lockfile";

import {
  getConfiguredDbLockRetries,
  getConfiguredDbLockStaleMs,
} from "../../platform/utils/limits.js";
import { DatabaseLockedError } from "./errors.js";

/**
 * Represents an acquired file lock.
 */
export interface FileLock {
  readonly lockPath: string;
  readonly release: () => Promise<void>;
}

/**
 * Tunable options for {@link acquireFileLock}. Defaults preserve the historical
 * behaviour (`stale: 30000`, `retries: 10`) and are sourced from
 * `platform/utils/limits.ts` so the env-override pattern stays consistent with
 * the rest of the server (resilience Phase D).
 */
export interface AcquireFileLockOptions {
  /** `proper-lockfile` stale window in ms — a crashed holder self-clears after this. */
  readonly staleMs?: number;
  /** `proper-lockfile` acquisition retries (with exponential backoff). */
  readonly retries?: number;
  /**
   * Best-effort liveness check for the pid recorded in the lock payload, used to
   * enrich the actionable error. Injectable for tests; defaults to a
   * `process.kill(pid, 0)` probe.
   */
  readonly isPidAlive?: (pid: number) => boolean;
}

/** Default best-effort liveness probe: signal 0 tests existence without killing. */
function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but we lack permission to signal it.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Best-effort read of the owning pid written into the plain `<lockPath>` file on
 * acquire. `proper-lockfile` stores its actual lock as a `<lockPath>.lock`
 * directory, so the plain file content is free for our pid payload. Returns
 * `undefined` if the file is missing/empty/unparseable.
 */
function readLockHolderPid(lockPath: string): number | undefined {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    if (raw === "") {
      return undefined;
    }
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Acquires an exclusive OS-level lock on a lock file.
 * Blocks (retrying) until the lock is available, or throws an actionable
 * {@link DatabaseLockedError} when another process holds it.
 *
 * @param dbPath - Path to the database file
 * @param options - Optional tunables (stale window, retries, liveness probe)
 * @returns FileLock object with lock path and release function
 */
export async function acquireFileLock(
  dbPath: string,
  options: AcquireFileLockOptions = {},
): Promise<FileLock> {
  const lockPath = `${dbPath}.lock`;
  const staleMs = options.staleMs ?? getConfiguredDbLockStaleMs();
  const retries = options.retries ?? getConfiguredDbLockRetries();
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;

  // Ensure lock directory exists
  await mkdir(dirname(lockPath), { recursive: true });

  // Ensure lock file exists — proper-lockfile requires it. Use append so we do
  // NOT clobber any pid the current holder wrote: on contention we want to read
  // THEIR pid back to report liveness.
  await writeFile(lockPath, "", { flag: "a" });

  // Acquire exclusive lock using proper-lockfile. This retries until available.
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(lockPath, { retries, stale: staleMs });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ELOCKED") {
      // Another process holds the lock. Enrich with the holder pid + liveness so
      // the message can say whether it crashed (self-clears) or is alive.
      const holderPid = readLockHolderPid(lockPath);
      const holderAlive = holderPid === undefined ? undefined : isPidAlive(holderPid);
      throw new DatabaseLockedError(dbPath, staleMs, err, holderPid, holderAlive);
    }
    throw err;
  }

  // Lock acquired — now record OUR pid into the plain file content so a future
  // restart can tell "held by a live process" from "stale from my own crash".
  // proper-lockfile's real lock is the `<lockPath>.lock` directory, so writing
  // the plain file does not affect the lock itself. Best-effort.
  await writeFile(lockPath, `${process.pid}\n`, { flag: "w" }).catch(() => undefined);

  return { lockPath, release };
}

/**
 * Releases an exclusive OS-level lock on a lock file.
 *
 * @param lock - FileLock object returned from acquireFileLock
 */
export async function releaseFileLock(lock: FileLock): Promise<void> {
  await lock.release();
}

/**
 * Synchronous, best-effort removal of a proper-lockfile lock for use inside a
 * `process.on("exit")` handler (the event loop is gone, so the async
 * `release()` cannot run).
 *
 * `proper-lockfile` represents a held lock as a directory at `<lockPath>.lock`.
 * Removing that directory drops the lock so a restart isn't blocked for the
 * stale window. All errors are swallowed — this is last-ditch cleanup.
 *
 * @param lockPath - The path passed to {@link acquireFileLock}'s lock (i.e.
 *   `${dbPath}.lock`); this function removes the proper-lockfile `<lockPath>.lock`
 *   directory it owns.
 */
export function releaseFileLockSync(lockPath: string): void {
  try {
    rmSync(`${lockPath}.lock`, { force: true, recursive: true });
  } catch {
    // best-effort: nothing else can run at exit time
  }
}
