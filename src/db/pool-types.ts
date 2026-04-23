/**
 * Connection pool types and configuration.
 * Requirements: 1.1, 10.1
 */

import type { Connection, Database } from "@ladybugdb/core";

/** Configuration for the connection pool. */
export interface PoolConfig {
  readonly minConnections: number;
  readonly maxConnections: number;
  readonly acquireTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly healthCheckIntervalMs: number;
}

/** Default pool configuration. */
export const DEFAULT_POOL_CONFIG: PoolConfig = {
  minConnections: 1,
  maxConnections: 5,
  acquireTimeoutMs: 5000,
  idleTimeoutMs: 30000,
  healthCheckIntervalMs: 60000,
};

/** A connection wrapper that tracks pool state. */
export interface PooledConnection {
  readonly connection: Connection;
  readonly database: Database;
  readonly dbPath: string;
  readonly createdAt: number;
  lastUsedAt: number;
  release(): Promise<void>;
}

/** Pool statistics for monitoring. */
export interface PoolStats {
  readonly totalConnections: number;
  readonly activeConnections: number;
  readonly idleConnections: number;
  readonly waitingRequests: number;
  readonly dbPath: string;
}
