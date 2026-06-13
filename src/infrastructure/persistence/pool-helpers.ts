/**
 * Internal helpers for ConnectionPool.
 * Extracted to keep connection-pool.ts under 250 lines.
 * Requirements: 1.2, 5.1
 */

import { Connection, Database } from "@ladybugdb/core";
import type { PoolConfig, PooledConnection } from "./pool-types.js";

/**
 * Validates pool configuration, throwing a descriptive error for invalid values.
 * Requirement 1.2
 */
export function validatePoolConfig(config: PoolConfig): void {
  if (config.maxConnections < 1) {
    throw new Error(
      `Invalid pool config: maxConnections must be >= 1, got ${config.maxConnections}`,
    );
  }
  if (config.minConnections < 0) {
    throw new Error(
      `Invalid pool config: minConnections must be >= 0, got ${config.minConnections}`,
    );
  }
  if (config.minConnections > config.maxConnections) {
    throw new Error(
      `Invalid pool config: minConnections (${config.minConnections}) must be <= maxConnections (${config.maxConnections})`,
    );
  }
  if (config.acquireTimeoutMs <= 0) {
    throw new Error(
      `Invalid pool config: acquireTimeoutMs must be > 0, got ${config.acquireTimeoutMs}`,
    );
  }
  if (config.idleTimeoutMs <= 0) {
    throw new Error(
      `Invalid pool config: idleTimeoutMs must be > 0, got ${config.idleTimeoutMs}`,
    );
  }
}

/**
 * Creates a PooledConnection wrapping a new Connection against the given Database.
 * The `releaseFn` is bound to the pool's release method.
 */
export async function createPooledConnection(
  database: Database,
  dbPath: string,
  releaseFn: (conn: PooledConnection) => Promise<void>,
): Promise<PooledConnection> {
  const connection = new Connection(database);
  await connection.init();

  const now = Date.now();
  const pooledConn: PooledConnection = {
    connection,
    database,
    dbPath,
    createdAt: now,
    lastUsedAt: now,
    async release(): Promise<void> {
      await releaseFn(pooledConn);
    },
  };

  return pooledConn;
}

/**
 * Validates a connection by executing a trivial query.
 * Returns true if healthy, false otherwise (never throws).
 * Requirement 5.1
 */
export async function validateConnection(conn: PooledConnection): Promise<boolean> {
  try {
    await conn.connection.query("RETURN 1");
    return true;
  } catch {
    return false;
  }
}


/**
 * Evicts idle connections that have exceeded idleTimeoutMs,
 * respecting minConnections.
 * Requirements: 4.1, 4.2
 */
export function evictIdleConnections(
  idle: PooledConnection[],
  activeCount: number,
  config: PoolConfig,
): void {
  const now = Date.now();
  let i = 0;
  while (i < idle.length) {
    const totalConnections = activeCount + idle.length;
    const conn = idle[i];
    if (
      now - conn.lastUsedAt > config.idleTimeoutMs &&
      totalConnections > config.minConnections
    ) {
      idle.splice(i, 1);
      // Fire-and-forget close — eviction is best-effort
      conn.connection.close().catch(() => {});
    } else {
      i++;
    }
  }
}
