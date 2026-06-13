/**
 * LadybugDB connection manager with retry logic.
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import { Database, Connection } from "@ladybugdb/core";
import { DatabaseConnectionError } from "./errors.js";
import { acquireFileLock, releaseFileLock, type FileLock } from "./file-lock.js";

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
): Promise<LadybugConnection> {
  // Acquire OS-level file lock to prevent concurrent access from multiple processes
  const lock = await acquireFileLock(dbPath);
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

  // Cache miss — retry loop (unchanged behaviour)
  let lastError: unknown;

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
