/**
 * Typed error classes for database operations.
 * Requirements: 6.4, 9.1
 */

/**
 * Thrown when LadybugDB connection fails after all retry attempts.
 * Carries the database path and the underlying cause for diagnostics.
 */
export class DatabaseConnectionError extends Error {
  public readonly name = "DatabaseConnectionError" as const;

  constructor(
    public readonly dbPath: string,
    public readonly cause: unknown,
  ) {
    super(`Failed to connect to LadybugDB at ${dbPath}`);
    Error.captureStackTrace(this, this.constructor);
  }
}


/**
 * Thrown when the database file lock cannot be acquired because another process
 * holds it (resilience Phase D). Unlike the opaque `proper-lockfile` error, this
 * names the dbPath and explains the self-healing behaviour so a supervisor or
 * operator knows what to do: wait for the stale window (a crashed holder
 * self-clears) or stop the live holder.
 */
export class DatabaseLockedError extends Error {
  public readonly name = "DatabaseLockedError" as const;

  constructor(
    public readonly dbPath: string,
    public readonly staleMs: number,
    public readonly cause: unknown,
    /** The pid recorded in the lock payload, if one was readable. */
    public readonly holderPid?: number,
    /** Whether {@link holderPid} appears to be a live process (best-effort). */
    public readonly holderAlive?: boolean,
  ) {
    super(DatabaseLockedError.buildMessage(dbPath, staleMs, holderPid, holderAlive));
    Error.captureStackTrace(this, this.constructor);
  }

  private static buildMessage(
    dbPath: string,
    staleMs: number,
    holderPid: number | undefined,
    holderAlive: boolean | undefined,
  ): string {
    const staleSeconds = Math.round(staleMs / 1000);
    let holder = "another server";
    if (holderPid !== undefined && holderPid > 0) {
      if (holderAlive === true) {
        holder = `a live process (pid ${holderPid})`;
      } else if (holderAlive === false) {
        holder = `a crashed/dead process (pid ${holderPid})`;
      } else {
        holder = `another server (pid ${holderPid})`;
      }
    }
    return (
      `Could not acquire the database lock for ${dbPath}: it is held by ${holder}. ` +
      `If that process crashed, the lock self-clears in ~${staleSeconds} s; ` +
      `otherwise stop the process holding ${dbPath} before retrying.`
    );
  }
}

/**
 * Thrown when acquire() times out waiting for a connection.
 * Requirement 9.1
 */
export class PoolExhaustedError extends Error {
  public readonly name = "PoolExhaustedError" as const;

  constructor(
    public readonly dbPath: string,
    public readonly timeoutMs: number,
  ) {
    super(`Connection pool exhausted for ${dbPath} (timeout: ${timeoutMs}ms)`);
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Thrown when acquire() is called on a drained pool.
 * Requirement 2.4
 */
export class PoolDrainedError extends Error {
  public readonly name = "PoolDrainedError" as const;

  constructor(public readonly dbPath: string) {
    super(`Connection pool is drained for ${dbPath}`);
    Error.captureStackTrace(this, this.constructor);
  }
}
