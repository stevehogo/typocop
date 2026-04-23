/** Connection pool for LadybugDB. Req: 1.2, 2.1–2.4, 3.1–3.3, 4.1–4.2, 5.1, 6.2, 10.1 */

import type { PoolConfig, PooledConnection, PoolStats } from "./pool-types.js";
import { DEFAULT_POOL_CONFIG } from "./pool-types.js";
import { PoolExhaustedError, PoolDrainedError } from "./errors.js";
import { createLadybugConnection, type LadybugConnection } from "./connection.js";
import {
  validatePoolConfig,
  createPooledConnection,
  validateConnection,
  evictIdleConnections,
} from "./pool-helpers.js";

/** Waiter in the acquire queue. */
interface Waiter {
  readonly resolve: (conn: PooledConnection) => void;
  readonly reject: (err: Error) => void;
}

/**
 * Manages a bounded set of Connection handles
 * for a single shared Database instance per dbPath.
 */
export class ConnectionPool {
  private readonly idle: PooledConnection[] = [];
  private readonly active: Set<PooledConnection> = new Set();
  private readonly waitQueue: Waiter[] = [];
  private readonly config: PoolConfig;
  private readonly dbPath: string;
  private readonly ladybugConnection: LadybugConnection;
  private drained = false;
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private drainResolve: (() => void) | null = null;

  private constructor(
    dbPath: string,
    config: PoolConfig,
    ladybugConnection: LadybugConnection,
  ) {
    this.dbPath = dbPath;
    this.config = config;
    this.ladybugConnection = ladybugConnection;
  }

  /** Creates a new ConnectionPool. Validates config, creates Database via singleton cache, pre-warms minConnections. */
  static async create(
    dbPath: string,
    config?: Partial<PoolConfig>,
  ): Promise<ConnectionPool> {
    const merged: PoolConfig = { ...DEFAULT_POOL_CONFIG, ...config };
    validatePoolConfig(merged);

    const ladybugConn = await createLadybugConnection(dbPath);

    const pool = new ConnectionPool(dbPath, merged, ladybugConn);

    // Pre-warm: the first connection comes from createLadybugConnection
    const firstConn = await pool.wrapAsPooled(ladybugConn);
    pool.idle.push(firstConn);

    // Create remaining minConnections - 1 connections
    for (let i = 1; i < merged.minConnections; i++) {
      const conn = await createPooledConnection(
        ladybugConn.database,
        dbPath,
        (c) => pool.release(c),
      );
      pool.idle.push(conn);
    }

    pool.startIdleTimer();
    return pool;
  }

  /** Acquires a connection. Tries idle (health-checked), creates new if below max, else waits. */
  async acquire(): Promise<PooledConnection> {
    if (this.drained) {
      throw new PoolDrainedError(this.dbPath);
    }

    // Try idle connections first
    while (this.idle.length > 0) {
      const conn = this.idle.pop()!;
      if (await validateConnection(conn)) {
        conn.lastUsedAt = Date.now();
        this.active.add(conn);
        return conn;
      }
      // Unhealthy — close and discard
      await conn.connection.close();
    }

    // Create new if below max
    const totalConnections = this.active.size + this.idle.length;
    if (totalConnections < this.config.maxConnections) {
      const conn = await createPooledConnection(
        this.ladybugConnection.database,
        this.dbPath,
        (c) => this.release(c),
      );
      this.active.add(conn);
      return conn;
    }

    // At max — wait with timeout (FIFO)
    return new Promise<PooledConnection>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      this.waitQueue.push(waiter);

      const timer = setTimeout(() => {
        const idx = this.waitQueue.indexOf(waiter);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
          reject(new PoolExhaustedError(this.dbPath, this.config.acquireTimeoutMs));
        }
      }, this.config.acquireTimeoutMs);

      // Store timer ref on waiter for cleanup
      (waiter as Waiter & { timer?: ReturnType<typeof setTimeout> }).timer = timer;
    });
  }

  /** Releases a connection back to the pool. Req 3.1, 3.2, 3.3 */
  async release(conn: PooledConnection): Promise<void> {
    if (!this.active.has(conn)) {
      console.warn("[connection-pool] Connection already released (double-release)");
      return;
    }

    this.active.delete(conn);

    if (this.drained) {
      await conn.connection.close();
      if (this.active.size === 0 && this.drainResolve) {
        this.drainResolve();
      }
      return;
    }

    // Hand off to next waiter (FIFO)
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      conn.lastUsedAt = Date.now();
      this.active.add(conn);
      // Clear the timeout for this waiter
      const w = waiter as Waiter & { timer?: ReturnType<typeof setTimeout> };
      if (w.timer) clearTimeout(w.timer);
      waiter.resolve(conn);
      return;
    }

    // Return to idle
    conn.lastUsedAt = Date.now();
    this.idle.push(conn);
  }

  /** Gracefully drains the pool. Req 6.2 */
  async drain(): Promise<void> {
    this.drained = true;
    this.stopIdleTimer();

    // Close all idle connections
    for (const conn of this.idle) {
      await conn.connection.close();
    }
    this.idle.length = 0;

    // Reject all waiters
    for (const waiter of this.waitQueue) {
      const w = waiter as Waiter & { timer?: ReturnType<typeof setTimeout> };
      if (w.timer) clearTimeout(w.timer);
      waiter.reject(new PoolDrainedError(this.dbPath));
    }
    this.waitQueue.length = 0;

    // Wait for active connections to be released
    if (this.active.size > 0) {
      await new Promise<void>((resolve) => {
        this.drainResolve = resolve;
      });
    }

    // Close the underlying LadybugConnection (handles Database close + cache cleanup)
    await this.ladybugConnection.close();
  }

  /** Returns current pool statistics. Req 10.1 */
  stats(): PoolStats {
    return {
      totalConnections: this.active.size + this.idle.length,
      activeConnections: this.active.size,
      idleConnections: this.idle.length,
      waitingRequests: this.waitQueue.length,
      dbPath: this.dbPath,
    };
  }

  /** Evicts idle connections exceeding idleTimeoutMs, respecting minConnections. Req 4.1, 4.2 */
  private evictIdleConnections(): void {
    evictIdleConnections(this.idle, this.active.size, this.config);
  }

  private startIdleTimer(): void {
    if (this.config.healthCheckIntervalMs > 0) {
      this.evictionTimer = setInterval(
        () => this.evictIdleConnections(),
        this.config.healthCheckIntervalMs,
      );
      if (this.evictionTimer && typeof this.evictionTimer === "object" && "unref" in this.evictionTimer) {
        (this.evictionTimer as NodeJS.Timeout).unref();
      }
    }
  }

  private stopIdleTimer(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }

  private wrapAsPooled(ladybugConn: LadybugConnection): PooledConnection {
    const now = Date.now();
    const pooledConn: PooledConnection = {
      connection: ladybugConn.connection,
      database: ladybugConn.database,
      dbPath: ladybugConn.dbPath,
      createdAt: now,
      lastUsedAt: now,
      release: async (): Promise<void> => {
        await this.release(pooledConn);
      },
    };
    return pooledConn;
  }
}
