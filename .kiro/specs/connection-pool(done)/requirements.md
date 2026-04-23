# Requirements: Connection Pool for LadybugDB

**Related documents:**
- [Lifecycle & Integration Requirements](./requirements-lifecycle.md)

## Requirement 1: Pool Configuration

### 1.1 Default Pool Configuration
The pool SHALL use these defaults: `minConnections: 1`, `maxConnections: 5`, `acquireTimeoutMs: 5000`, `idleTimeoutMs: 30000`, `healthCheckIntervalMs: 60000`.

**Acceptance Criteria:**
- Creating a pool without config uses all default values
- Each default can be overridden individually via `Partial<PoolConfig>`

### 1.2 Configuration Validation
The pool SHALL reject invalid configurations at creation time.

**Acceptance Criteria:**
- `minConnections` must be >= 0 and <= `maxConnections`
- `maxConnections` must be >= 1
- `acquireTimeoutMs` must be > 0
- `idleTimeoutMs` must be > 0
- Invalid config throws a descriptive error before any connections are created

## Requirement 2: Connection Acquisition

### 2.1 Acquire from Idle Pool
When idle connections exist, `acquire()` SHALL return a health-checked idle connection.

**Acceptance Criteria:**
- Returns an idle connection without creating a new one
- Connection is validated via health check before returning
- Unhealthy idle connections are discarded and replaced
- `stats().activeConnections` increments by 1

### 2.2 Acquire with New Connection
When no idle connections exist and pool is below `maxConnections`, `acquire()` SHALL create a new connection.

**Acceptance Criteria:**
- New `Connection` is created against the shared `Database` singleton
- `Connection.init()` is called before returning
- `stats().totalConnections` increments by 1

### 2.3 Acquire with Timeout
When pool is at `maxConnections` and all active, `acquire()` SHALL wait up to `acquireTimeoutMs` then throw `PoolExhaustedError`.

**Acceptance Criteria:**
- Caller blocks until a connection is released or timeout expires
- `PoolExhaustedError` includes `dbPath` and `timeoutMs`
- Waiting callers are served in FIFO order

### 2.4 Acquire on Drained Pool
Calling `acquire()` on a drained pool SHALL throw immediately.

**Acceptance Criteria:**
- Throws an error indicating the pool is drained
- Does not attempt to create connections

## Requirement 3: Connection Release

### 3.1 Release Returns to Idle Pool
`release()` SHALL return the connection to the idle list for reuse.

**Acceptance Criteria:**
- `stats().activeConnections` decrements by 1
- `stats().idleConnections` increments by 1
- Connection's `lastUsedAt` is updated

### 3.2 Release Hands Off to Waiter
When waiters exist, `release()` SHALL hand the connection directly to the next waiter (FIFO).

**Acceptance Criteria:**
- Connection goes directly to the longest-waiting caller
- Connection does not enter the idle list
- Waiter's `acquire()` promise resolves with the connection

### 3.3 Release Idempotency
Calling `release()` on an already-released connection SHALL be a no-op.

**Acceptance Criteria:**
- No error thrown on double release
- Warning is logged
- Pool state is not corrupted

## Requirement 4: Idle Connection Management

### 4.1 Idle Timeout Eviction
Connections idle longer than `idleTimeoutMs` SHALL be evicted and closed.

**Acceptance Criteria:**
- Eviction runs periodically
- Only connections exceeding `idleTimeoutMs` are evicted
- `stats().totalConnections` decreases for each evicted connection

### 4.2 Minimum Connection Guarantee
Idle eviction SHALL NOT reduce total connections below `minConnections`.

**Acceptance Criteria:**
- If `totalConnections` equals `minConnections`, no eviction occurs
- Minimum is maintained even if all remaining connections are idle and expired

## Requirement 5: Health Checking

### 5.1 Health Check on Acquire
Before returning an idle connection, the pool SHALL validate it with a trivial query.

**Acceptance Criteria:**
- Executes `RETURN 1` (or equivalent) against the connection
- Healthy connections are returned to the caller
- Unhealthy connections are closed and discarded
- A new connection is created if the discarded one was the last idle
