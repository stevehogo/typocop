/**
 * File-based locking for cross-process database access serialization.
 * Uses OS-level exclusive locks to ensure only one process accesses the database at a time.
 */

import { dirname } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import * as lockfile from "proper-lockfile";

/**
 * Represents an acquired file lock.
 */
export interface FileLock {
  readonly lockPath: string;
  readonly release: () => Promise<void>;
}

/**
 * Acquires an exclusive OS-level lock on a lock file.
 * Blocks until the lock is available.
 *
 * @param dbPath - Path to the database file
 * @returns FileLock object with lock path and release function
 */
export async function acquireFileLock(dbPath: string): Promise<FileLock> {
  const lockPath = `${dbPath}.lock`;

  // Ensure lock directory exists
  await mkdir(dirname(lockPath), { recursive: true });

  // Ensure lock file exists — proper-lockfile requires it
  await writeFile(lockPath, "", { flag: "a" });

  // Acquire exclusive lock using proper-lockfile
  // This blocks until the lock is available
  const release = await lockfile.lock(lockPath, {
    retries: 10,
    stale: 30000,
  });

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

