Part of the [Connection Pool Design](./design.md).
See also: [Algorithm Pseudocode](./design-pseudocode.md)

# Data Models & Formal Specifications

## Key Functions with Formal Specifications

### Function: `ConnectionPool.acquire()`

```typescript
async acquire(): Promise<PooledConnection>
```

**Preconditions:**
- Pool is not drained (`this.drained === false`)
- `this.config.acquireTimeoutMs > 0`

**Postconditions:**
- Returns a valid, health-checked `PooledConnection`
- `stats().activeConnections` incremented by 1
- `stats().totalConnections <= config.maxConnections`
- Returned connection's `lastUsedAt` is updated to `Date.now()`

**Loop Invariants:**
- `activeConnections + idleConnections <= maxConnections` at all times

### Function: `ConnectionPool.release()`

```typescript
async release(conn: PooledConnection): Promise<void>
```

**Preconditions:**
- `conn` was acquired from this pool
- `conn` has not already been released

**Postconditions:**
- `stats().activeConnections` decremented by 1
- If pool is not drained: connection returned to idle list
- If pool is drained: connection is closed
- If waiters exist: next waiter receives the connection

### Function: `ConnectionPool.drain()`

```typescript
async drain(): Promise<void>
```

**Preconditions:**
- Pool exists and has not been drained

**Postconditions:**
- All idle connections closed
- Waits for all active connections to be released, then closes them
- `stats().totalConnections === 0`
- Pool marked as drained; subsequent `acquire()` throws
- Underlying `Database` closed and removed from singleton cache

### Function: `validateConnection()`

```typescript
private async validateConnection(conn: PooledConnection): Promise<boolean>
```

**Preconditions:**
- `conn.connection` is a `Connection` object (may be stale)

**Postconditions:**
- Returns `true` if connection can execute a trivial query
- Returns `false` if connection is broken (never throws)

## Example Usage

```typescript
// Basic acquire/release pattern
const pool = await ConnectionPool.create("/tmp/project.ladybug", {
  maxConnections: 3,
  idleTimeoutMs: 15000,
});

const conn = await pool.acquire();
try {
  const result = await conn.connection.query("MATCH (n) RETURN count(n)");
} finally {
  await pool.release(conn);
}

// Module-level registry
const pool = await getPool("/tmp/project.ladybug");
const conn = await pool.acquire();
await pool.release(conn);

// Graceful shutdown
await drainAllPools();
```
