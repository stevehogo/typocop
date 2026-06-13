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
