/** Module-level pool registry — one pool per dbPath. Req 7.1 */

import { ConnectionPool } from "./connection-pool.js";
import type { PoolConfig } from "./pool-types.js";

const poolRegistry = new Map<string, ConnectionPool>();

/** Get or create a pool for the given dbPath. */
export async function getPool(
  dbPath: string,
  config?: Partial<PoolConfig>,
): Promise<ConnectionPool> {
  const existing = poolRegistry.get(dbPath);
  if (existing) {
    return existing;
  }

  const pool = await ConnectionPool.create(dbPath, config);
  poolRegistry.set(dbPath, pool);
  return pool;
}

/** Drain and remove a specific pool. */
export async function removePool(dbPath: string): Promise<void> {
  const pool = poolRegistry.get(dbPath);
  if (!pool) {
    return;
  }

  poolRegistry.delete(dbPath);
  await pool.drain();
}

/** Drain all pools — used in graceful shutdown. */
export async function drainAllPools(): Promise<void> {
  const pools = [...poolRegistry.values()];
  poolRegistry.clear();
  await Promise.all(pools.map((pool) => pool.drain()));
}

/** Reset registry — test isolation only. */
export function resetPoolRegistry(): void {
  poolRegistry.clear();
}
