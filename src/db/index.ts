/**
 * Public API for the database module.
 * Re-exports pool, adapter, connection, and error types.
 */

// Pool
export { ConnectionPool } from "./connection-pool.js";
export { getPool, removePool, drainAllPools, resetPoolRegistry } from "./pool-registry.js";
export { DEFAULT_POOL_CONFIG } from "./pool-types.js";
export type { PoolConfig, PooledConnection, PoolStats } from "./pool-types.js";
export { PoolExhaustedError, PoolDrainedError, DatabaseConnectionError } from "./errors.js";

// Adapter
export { LadybugDatabaseAdapter, createDatabaseAdapter } from "./database-adapter.js";

// Connection (backward-compatible)
export { createLadybugConnection, resetConnectionCache } from "./connection.js";
export type { LadybugConnection } from "./connection.js";
