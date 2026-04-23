Part of the [Connection Pool Tasks](./tasks.md).

# Testing Tasks

## Phase 7: ConnectionPool Unit Tests

- [x] 9. Write unit tests for ConnectionPool
  _Skills: `testing-patterns`, `tdd-workflow`
  - [x] 9.1 Test `create()` with default config and custom config overrides (Req 1.1)
  - [x] 9.2 Test `create()` rejects invalid configurations (Req 1.2)
  - [x] 9.3 Test `acquire()` returns idle connection when available (Req 2.1)
  - [x] 9.4 Test `acquire()` creates new connection when idle empty and below max (Req 2.2)
  - [x] 9.5 Test `acquire()` throws `PoolExhaustedError` on timeout (Req 2.3)
  - [x] 9.6 Test `acquire()` throws on drained pool (Req 2.4)
  - [x] 9.7 Test `release()` returns connection to idle (Req 3.1)
  - [x] 9.8 Test `release()` hands off to waiting acquirer in FIFO order (Req 3.2)
  - [x] 9.9 Test `release()` double-release is idempotent (Req 3.3)
  - [x] 9.10 Test idle eviction with fake timers (Req 4.1)
  - [x] 9.11 Test eviction respects `minConnections` (Req 4.2)
  - [x] 9.12 Test health check discards unhealthy connections (Req 5.1)
  - [x] 9.13 Test `drain()` closes all connections and rejects new acquires (Req 6.2)
  - [x] 9.14 Test `stats()` returns accurate counts (Req 10.1)

## Phase 8: Registry and Adapter Unit Tests

- [x] 10. Write unit tests for pool registry
  _Skills: `testing-patterns`
  - [x] 10.1 Test `getPool()` returns same pool for same `dbPath`
  - [x] 10.2 Test `removePool()` drains and removes pool
  - [x] 10.3 Test `drainAllPools()` drains all registered pools
  - [x] 10.4 Test `resetPoolRegistry()` clears registry

- [x] 11. Write unit tests for adapter integration
  _Skills: `testing-patterns`
  - [x] 11.1 Test `LadybugDatabaseAdapter.initialize()` acquires from pool
  - [x] 11.2 Test `LadybugDatabaseAdapter.close()` releases to pool
  - [x] 11.3 Verify existing `database-adapter.test.ts` tests still pass

## Phase 9: Consumer Migration Tests

- [x] 12. Write tests for consumer migration
  _Skills: `testing-patterns`
  - [x] 12.1 Test MCP server `transport.onclose` calls `drainAllPools()`
  - [x] 12.2 Test CLI executor `executeIndexingPipeline` works with pool-backed adapter
  - [x] 12.3 Test CLI executor `readGraphStatus` works with pool-backed adapter
  - [x] 12.4 Test obsidian CLI calls `drainAllPools()` on exit
  - [x] 12.5 Verify no production code outside `src/db/` imports `createLadybugConnection` directly

## Phase 10: Property-Based Tests

- [x] 13. Write property-based tests for connection pool
  _Skills: `testing-patterns`
  - [x] 13.1 Property: `stats().totalConnections === stats().activeConnections + stats().idleConnections` for any sequence of acquire/release
  - [x] 13.2 Property: `stats().totalConnections` stays within `[minConnections, maxConnections]` for any operation sequence after warmup
  - [x] 13.3 Property: FIFO ordering -- for any N waiters, connections are handed out in order of waiting
  - [x] 13.4 Property: idle eviction never reduces `totalConnections` below `minConnections`

## Phase 11: Verify Existing Tests

- [x] 14. Ensure no regressions
  _Skills: `testing-patterns`
  - [x] 14.1 Run `connection.test.ts` -- all existing tests pass
  - [x] 14.2 Run `connection-singleton.test.ts` -- all existing tests pass
  - [x] 14.3 Run `database-adapter.test.ts` -- all existing tests pass
  - [x] 14.4 Run `executor.test.ts` -- all existing tests pass
  - [x] 14.5 Run `mcp/server` tests -- all existing tests pass
  - [x] 14.6 Run full test suite -- no regressions
