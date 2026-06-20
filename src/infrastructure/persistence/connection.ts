/**
 * LadybugDB connection manager with retry logic.
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import { Database, Connection } from "@ladybugdb/core";
import { rename, access } from "node:fs/promises";
import { DatabaseConnectionError } from "./errors.js";
import { acquireFileLock, releaseFileLock, type FileLock, type LockTunables } from "./file-lock.js";

/** Retry configuration constants. */
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 200;

/** Entry in the module-level connection cache. */
interface CacheEntry {
  readonly database: Database;
  refCount: number;
}

/** Module-level singleton cache keyed by dbPath. */
const connectionCache = new Map<string, CacheEntry>();

/** Track active file locks keyed by dbPath. */
const activeLocks = new Map<string, FileLock>();

/** Managed LadybugDB connection exposing Cypher and SQL via a single Connection. */
export interface LadybugConnection {
  readonly database: Database;
  readonly connection: Connection;
  readonly dbPath: string;
  close(): Promise<void>;
}

/**
 * Pause execution for the given number of milliseconds.
 * Extracted for testability (can be overridden via dependency injection).
 */
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Quarantines a corrupted LadybugDB WAL so a retry can reopen the DB from its
 * last checkpoint. Injectable for testability; defaults to a real fs rename of
 * `<dbPath>.wal` → `<dbPath>.wal.corrupt-bak-<ts>` (matching the on-disk
 * convention). Best-effort — returns false and never throws when there is no
 * WAL or the rename fails, so the caller falls through to normal retry/exhaustion.
 */
export type QuarantineWalFn = (dbPath: string) => Promise<boolean>;

function walBackupStamp(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

const defaultQuarantineWal: QuarantineWalFn = async (dbPath: string): Promise<boolean> => {
  const walPath = `${dbPath}.wal`;
  try {
    await access(walPath);
  } catch {
    return false; // no WAL present — nothing to quarantine
  }
  try {
    const dest = `${walPath}.corrupt-bak-${walBackupStamp(new Date())}`;
    await rename(walPath, dest);
    console.error(`[ladybugdb] Quarantined corrupt WAL ${walPath} -> ${dest}; retrying connection`);
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ladybugdb] Failed to quarantine corrupt WAL ${walPath}: ${msg}`);
    return false;
  }
};

/**
 * True when an error looks like a corrupted-WAL failure from LadybugDB
 * (e.g. "Runtime exception: Corrupted wal file. Read out invalid WAL record type.").
 */
export function isCorruptWalError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /corrupt(?:ed)?\s+wal|invalid\s+wal\s+record/i.test(msg);
}

/**
 * Creates a LadybugDB connection with exponential-backoff retry.
 *
 * - Req 6.1: Database created at dbPath, Connection wraps it
 * - Req 6.2: Retries up to 3 times with 200ms / 400ms delays
 * - Req 6.3: `close()` shuts down both connection and database (ref-counted)
 * - Req 6.4: Throws `DatabaseConnectionError` after all retries exhausted
 * - Req 2.1–2.4: Singleton cache — same dbPath shares one Database
 */
export async function createLadybugConnection(
  dbPath: string,
  sleep: SleepFn = defaultSleep,
  lockOptions: LockTunables = {},
  quarantineWal: QuarantineWalFn = defaultQuarantineWal,
): Promise<LadybugConnection> {
  // Acquire OS-level file lock to prevent concurrent access from multiple processes.
  // `staleMs`/`retries` are threaded from the server's per-repo config when supplied;
  // when omitted they fall back to the env-configured defaults (see LockTunables), so
  // config-less callers (the pool, embedded use, tests) keep the process-global default.
  const lock = await acquireFileLock(dbPath, lockOptions);
  activeLocks.set(dbPath, lock);

  // Cache hit — reuse existing Database, create a fresh Connection
  const cached = connectionCache.get(dbPath);
  if (cached) {
    cached.refCount++;
    const connection = new Connection(cached.database);
    await connection.init();

    return {
      database: cached.database,
      connection,
      dbPath,
      async close(): Promise<void> {
        await connection.close();
        cached.refCount--;
        if (cached.refCount === 0) {
          connectionCache.delete(dbPath);
          const activeLock = activeLocks.get(dbPath);
          if (activeLock) {
            await releaseFileLock(activeLock);
            activeLocks.delete(dbPath);
          }
          await cached.database.close();
        }
      },
    };
  }

  // Cache miss — retry loop
  let lastError: unknown;
  let quarantinedWal = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const database = new Database(dbPath);
      await database.init();

      const entry: CacheEntry = { database, refCount: 1 };
      connectionCache.set(dbPath, entry);

      const connection = new Connection(database);
      await connection.init();

      return {
        database,
        connection,
        dbPath,
        async close(): Promise<void> {
          await connection.close();
          entry.refCount--;
          if (entry.refCount === 0) {
            connectionCache.delete(dbPath);
            const activeLock = activeLocks.get(dbPath);
            if (activeLock) {
              await releaseFileLock(activeLock);
              activeLocks.delete(dbPath);
            }
            await database.close();
          }
        },
      };
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ladybugdb] Connection attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`);

      // Self-heal a corrupted WAL exactly once: move it aside so the next
      // attempt can reopen the DB from its last checkpoint instead of the server
      // fatal-exiting. A killed-mid-write server is the usual cause; with
      // `--refresh` the recovered graph is rebuilt anyway.
      if (!quarantinedWal && isCorruptWalError(err)) {
        quarantinedWal = await quarantineWal(dbPath);
      }

      if (attempt < MAX_ATTEMPTS) {
        const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delayMs);
      }
    }
  }

  const activeLock = activeLocks.get(dbPath);
  if (activeLock) {
    await releaseFileLock(activeLock);
    activeLocks.delete(dbPath);
  }
  throw new DatabaseConnectionError(dbPath, lastError);
}

/**
 * Clears the module-level connection cache.
 * Intended for test isolation — call in `beforeEach` to prevent cross-test leakage.
 */
export function resetConnectionCache(): void {
  connectionCache.clear();
}
