Part of the [Connection Pool Design](./design.md).

# Components & Interfaces

## Core Interfaces/Types

```typescript
/** Configuration for the connection pool. */
interface PoolConfig {
  readonly minConnections: number;   // minimum idle connections to maintain (default: 1)
  readonly maxConnections: number;   // maximum total connections (default: 5)
  readonly acquireTimeoutMs: number; // max wait time for acquire() (default: 5000)
  readonly idleTimeoutMs: number;    // evict idle connections after this (default: 30000)
  readonly healthCheckIntervalMs: number; // interval between health checks (default: 60000)
}

/** Default pool configuration. */
const DEFAULT_POOL_CONFIG: PoolConfig = {
  minConnections: 1,
  maxConnections: 5,
  acquireTimeoutMs: 5000,
  idleTimeoutMs: 30000,
  healthCheckIntervalMs: 60000,
};

/** A connection wrapper that tracks pool state. */
interface PooledConnection {
  readonly connection: Connection;   // the underlying @ladybugdb/core Connection
  readonly database: Database;       // the shared Database instance
  readonly dbPath: string;
  readonly createdAt: number;        // timestamp of creation
  lastUsedAt: number;                // timestamp of last acquire
  release(): Promise<void>;          // return to pool
}

/** Pool statistics for monitoring. */
interface PoolStats {
  readonly totalConnections: number;  // active + idle
  readonly activeConnections: number; // currently acquired
  readonly idleConnections: number;   // available for acquire
  readonly waitingRequests: number;   // callers blocked on acquire
  readonly dbPath: string;
}

/** Thrown when acquire() times out waiting for a connection. */
class PoolExhaustedError extends Error {
  readonly name = "PoolExhaustedError" as const;
  constructor(
    readonly dbPath: string,
    readonly timeoutMs: number,
  ) {
    super(`Connection pool exhausted for ${dbPath} (timeout: ${timeoutMs}ms)`);
  }
}
```

## ConnectionPool Class

```typescript
class ConnectionPool {
  // Lifecycle
  static async create(dbPath: string, config?: Partial<PoolConfig>): Promise<ConnectionPool>;
  
  // Connection management
  acquire(): Promise<PooledConnection>;
  release(conn: PooledConnection): Promise<void>;
  
  // Pool lifecycle
  drain(): Promise<void>;          // graceful shutdown — wait for active, close all
  
  // Monitoring
  stats(): PoolStats;
  
  // Internal (private)
  private createConnection(): Promise<PooledConnection>;
  private validateConnection(conn: PooledConnection): Promise<boolean>;
  private evictIdleConnections(): void;
  private startIdleTimer(): void;
  private stopIdleTimer(): void;
}
```

### Responsibilities

- Manage a bounded set of `Connection` objects for a single `Database`
- Reuse the existing singleton `Database` cache (one `Database` per `dbPath`)
- Provide acquire/release semantics with timeout
- Evict idle connections that exceed `idleTimeoutMs`
- Maintain at least `minConnections` idle connections
- Validate connection health before returning from `acquire()`
- Support graceful shutdown via `drain()`

## ConnectionPoolManager (Module-Level Registry)

```typescript
/** Module-level pool registry — one pool per dbPath. */
const poolRegistry = new Map<string, ConnectionPool>();

/** Get or create a pool for the given dbPath. */
async function getPool(
  dbPath: string,
  config?: Partial<PoolConfig>,
): Promise<ConnectionPool>;

/** Drain and remove a specific pool. */
async function removePool(dbPath: string): Promise<void>;

/** Drain all pools — used in graceful shutdown. */
async function drainAllPools(): Promise<void>;

/** Reset registry — test isolation only. */
function resetPoolRegistry(): void;
```

## Integration with LadybugDatabaseAdapter

The adapter changes from holding a single `LadybugConnection` to acquiring/releasing pooled connections:

```typescript
class LadybugDatabaseAdapter implements DatabaseAdapter {
  private pool: ConnectionPool | null = null;
  private activeConn: PooledConnection | null = null;

  async initialize(): Promise<void> {
    this.pool = await getPool(this.config.ladybugdb.dbPath);
    this.activeConn = await this.pool.acquire();
    // wire up graph/vector/embedding adapters using activeConn.connection
  }

  async close(): Promise<void> {
    if (this.activeConn && this.pool) {
      await this.pool.release(this.activeConn);
    }
  }
}
```

See also: [Consumer Migration](./design-migration.md)
