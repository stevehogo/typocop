Part of the [Connection Pool Design](./design.md).

# Correctness Properties & Testing Strategy

## Correctness Properties

### Property 1: Pool Size Invariant

_For any_ pool with config `{ minConnections: min, maxConnections: max }`, at all times:
`min <= stats().totalConnections <= max` (once pool is warmed up and not drained).

After `drain()`, `stats().totalConnections === 0`.

### Property 2: Acquire-Release Conservation

_For any_ sequence of N `acquire()` calls followed by N `release()` calls on the same pool,
`stats().activeConnections` returns to 0 and `stats().idleConnections` equals the number of
non-evicted connections.

### Property 3: No Connection Leaks

_For any_ pool, `stats().totalConnections === stats().activeConnections + stats().idleConnections`
at all observable points (no connections exist outside these two sets).

### Property 4: Acquire Timeout Guarantee

_For any_ pool at maximum capacity with all connections active, a new `acquire()` call
SHALL throw `PoolExhaustedError` within `config.acquireTimeoutMs ± 50ms` if no connection
is released in that window.

### Property 5: Idle Eviction Respects Minimum

_For any_ pool, idle eviction SHALL NOT reduce `stats().totalConnections` below
`config.minConnections`. Connections are only evicted when `totalConnections > minConnections`.

### Property 6: Health Check Transparency

_For any_ unhealthy connection in the idle list, `acquire()` SHALL discard it and either
return a different healthy connection or create a new one. The caller never receives an
unhealthy connection.

### Property 7: Release Idempotency

_For any_ connection, calling `release()` more than once SHALL NOT corrupt pool state.
The second call is a no-op with a warning log.

### Property 8: Drain Completeness

_For any_ pool, after `drain()` resolves: all connections are closed,
`stats().totalConnections === 0`, and subsequent `acquire()` throws.

### Property 9: Database Singleton Preservation

_For any_ two pools (or pool + direct `createLadybugConnection`) using the same `dbPath`,
they SHALL share the same underlying `Database` instance. `new Database()` is called
at most once per unique `dbPath`.

### Property 10: FIFO Waiter Ordering

_For any_ set of callers waiting on `acquire()` when the pool is full, connections SHALL
be handed out in FIFO order as they become available via `release()`.

## Testing Strategy

### Unit Testing Approach

- Mock `@ladybugdb/core` `Database` and `Connection` (same pattern as existing tests)
- Test acquire/release cycles with various pool sizes
- Test timeout behavior with controlled timing
- Test idle eviction with fake timers (`vi.useFakeTimers()`)
- Test drain behavior with active and idle connections
- Test health check failure and connection replacement
- Test double-release idempotency

### Property-Based Testing Approach

**Property Test Library**: fast-check

**Key Property Tests:**

1. **Acquire-Release Conservation**: Generate random sequences of acquire/release operations.
   Assert `activeConnections` always matches the number of unreleased acquires.

2. **Pool Size Invariant**: Generate random pool configs and operation sequences.
   Assert `totalConnections` stays within `[min, max]` bounds.

3. **No Connection Leaks**: Generate random operation sequences including eviction triggers.
   Assert `total === active + idle` after each operation.

4. **FIFO Ordering**: Generate sequences where pool is full and multiple waiters queue up.
   Assert connections are handed out in order of waiting.

### Integration Testing Approach

- Test `LadybugDatabaseAdapter` using pool instead of direct connection
- Test pool registry (`getPool`, `removePool`, `drainAllPools`)
- Test that existing `connection.test.ts` and `database-adapter.test.ts` still pass
- Test pool behavior under concurrent acquire calls using `Promise.all`
