# Tasks: Connection Pool for LadybugDB

**Related documents:**
- [Implementation Tasks (continued)](./tasks-implementation.md)
- [Testing Tasks](./tasks-testing.md)

## Phase 1: Core Types & Error Classes

- [x] 1. Create pool types and error classes
  _Skills: `typescript-expert`, `error-handling-patterns`
  - [x] 1.1 Create `src/db/pool-types.ts` with `PoolConfig`, `PooledConnection`, `PoolStats` interfaces and `DEFAULT_POOL_CONFIG` constant
  - [x] 1.2 Add `PoolExhaustedError` to `src/db/errors.ts` with `dbPath` and `timeoutMs` properties
  - [x] 1.3 Add `PoolDrainedError` to `src/db/errors.ts`

  **Requirements:** 1.1, 9.1

## Phase 2: ConnectionPool Implementation

- [x] 2. Implement ConnectionPool class
  _Skills: `typescript-expert`, `nodejs-best-practices`, `error-handling-patterns`
  - [x] 2.1 Create `src/db/connection-pool.ts` with `ConnectionPool` class skeleton (constructor, private state)
  - [x] 2.2 Implement `static async create(dbPath, config?)` -- validates config, creates Database via existing singleton cache, creates `minConnections` initial connections
  - [x] 2.3 Implement `acquire()` -- try idle (with health check), create new if below max, else wait with timeout
  - [x] 2.4 Implement `release(conn)` -- return to idle, hand off to waiter, or handle double-release
  - [x] 2.5 Implement `drain()` -- close idle, wait for active, close Database, mark drained
  - [x] 2.6 Implement `stats()` -- return current pool state
  - [x] 2.7 Implement private `validateConnection()` -- execute trivial query
  - [x] 2.8 Implement private `evictIdleConnections()` -- timer-based eviction respecting minConnections
  - [x] 2.9 Implement config validation in `create()` -- reject invalid configs

  **Requirements:** 1.2, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 4.1, 4.2, 5.1, 6.2, 10.1

## Phase 3: Pool Registry

- [x] 3. Implement module-level pool registry
  _Skills: `typescript-expert`, `clean-code`
  - [x] 3.1 Create `src/db/pool-registry.ts` with `getPool()`, `removePool()`, `drainAllPools()`, `resetPoolRegistry()`
  - [x] 3.2 Ensure `getPool()` returns existing pool for same `dbPath` or creates new one

  **Requirements:** 7.1
