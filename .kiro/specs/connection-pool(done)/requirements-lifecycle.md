Part of the [Connection Pool Requirements](./requirements.md).

# Lifecycle & Integration Requirements

## Requirement 6: Pool Lifecycle

### 6.1 Pool Creation with Database Singleton
`ConnectionPool.create()` SHALL reuse the existing `Database` singleton cache.

**Acceptance Criteria:**
- Uses `createLadybugConnection` internally for the first connection
- Shares the same `Database` instance as any other pool or direct connection for the same `dbPath`
- Retry-with-backoff logic for `Database` creation is preserved

### 6.2 Graceful Drain
`drain()` SHALL close all idle connections, wait for active connections to be released, then close the `Database`.

**Acceptance Criteria:**
- All idle connections closed immediately
- Active connections closed as they are released
- Waiting acquirers receive an error
- `stats().totalConnections` reaches 0
- Subsequent `acquire()` throws

## Requirement 7: Pool Registry

### 7.1 Module-Level Pool Registry
A module-level registry SHALL manage one pool per `dbPath`.

**Acceptance Criteria:**
- `getPool(dbPath)` returns existing pool or creates a new one
- `removePool(dbPath)` drains and removes a specific pool
- `drainAllPools()` drains all pools (graceful shutdown)
- `resetPoolRegistry()` clears registry for test isolation

## Requirement 8: Adapter Integration

### 8.1 LadybugDatabaseAdapter Uses Pool
`LadybugDatabaseAdapter` SHALL acquire connections from the pool instead of creating direct connections.

**Acceptance Criteria:**
- `initialize()` acquires a connection from the pool
- `close()` releases the connection back to the pool (not closing the `Database`)
- Existing tests for `LadybugDatabaseAdapter` continue to pass
- Graph, vector, and embedding adapters work with pooled connections

## Requirement 9: Error Types

### 9.1 PoolExhaustedError
A typed `PoolExhaustedError` SHALL be thrown when acquire times out.

**Acceptance Criteria:**
- Extends `Error`
- Has `name: "PoolExhaustedError"`
- Includes `dbPath` and `timeoutMs` properties
- Has a descriptive message

## Requirement 10: Monitoring

### 10.1 Pool Statistics
`stats()` SHALL return current pool state.

**Acceptance Criteria:**
- Returns `totalConnections`, `activeConnections`, `idleConnections`, `waitingRequests`, `dbPath`
- `totalConnections === activeConnections + idleConnections`
- Values are accurate at the time of the call

## Requirement 11: Consumer Migration

### 11.1 MCP Server Uses Pool
`src/mcp/server.ts` SHALL use the pool registry instead of calling `createDatabaseAdapter` directly.

**Acceptance Criteria:**
- MCP server acquires adapter via pool on startup
- Transport disconnect calls `drainAllPools()` instead of `adapter.close()`
- Concurrent MCP tool calls share the same pool

### 11.2 CLI Executor Uses Pool
`src/cli/executor.ts` SHALL use pool-backed adapters and drain on exit.

**Acceptance Criteria:**
- `executeIndexingPipeline` uses `createDatabaseAdapter` (which internally uses pool)
- `readGraphStatus` uses pool-backed adapter
- Obsidian export command uses pool-backed adapter
- All `finally` blocks call `adapter.close()` (which releases to pool, not destroys)

### 11.3 Obsidian CLI Uses Pool
`src/cli/obsidian-main.ts` SHALL use pool-backed adapters.

**Acceptance Criteria:**
- Uses `createDatabaseAdapter` (which internally uses pool)
- Calls `drainAllPools()` on process exit for clean shutdown

### 11.4 No Direct `createLadybugConnection` Outside Pool
After migration, no production code outside `src/db/` SHALL call `createLadybugConnection` directly.

**Acceptance Criteria:**
- Only `ConnectionPool.create()` and test code call `createLadybugConnection`
- `createDatabaseAdapter` uses pool internally
- grep for `createLadybugConnection` in `src/` (excluding `src/db/` and test files) returns zero results
