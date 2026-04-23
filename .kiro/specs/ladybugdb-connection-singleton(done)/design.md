# LadybugDB Connection Singleton Bugfix Design

## Overview

The `createLadybugConnection` function in `src/db/connection.ts` creates a new `Database` instance on every call, even for the same `dbPath`. Since Kùzu locks the database file per process, concurrent intra-process consumers fail with `DatabaseConnectionError`. The fix introduces a module-level singleton cache (`Map<string, { database, refCount }>`) keyed by `dbPath`, with reference-counted `close()` so the underlying `Database` is only released when the last consumer disconnects.

## Glossary

- **Bug_Condition (C)**: Multiple calls to `createLadybugConnection` with the same `dbPath` within one process, causing duplicate `Database` instantiation and file-lock conflicts
- **Property (P)**: All callers for the same `dbPath` share one `Database`; each gets its own `Connection`; `close()` is reference-counted
- **Preservation**: Retry logic, `DatabaseConnectionError` on exhaustion, separate `Database` per distinct `dbPath`, and the `LadybugConnection` interface shape remain unchanged
- **Connection cache**: Module-level `Map<string, { database: Database; refCount: number }>` storing one `Database` per `dbPath`
- **refCount**: Number of active `LadybugConnection` handles sharing a cached `Database`

## Bug Details

### Bug Condition

The bug manifests when two or more callers within the same process invoke `createLadybugConnection` with the same `dbPath`. The second caller attempts to open a new `Database` on an already-locked file, exhausts retries, and throws `DatabaseConnectionError`.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { dbPath: string, existingOpenDatabase: boolean }
  OUTPUT: boolean

  RETURN input.existingOpenDatabase == true
         AND createLadybugConnection(input.dbPath) is called
         AND a NEW Database(input.dbPath) is attempted
END FUNCTION
```

### Examples

- Caller A opens `/tmp/project.ladybug`, then Caller B opens `/tmp/project.ladybug` → B fails with `DatabaseConnectionError` after 3 retries (expected: B succeeds, sharing A's Database)
- Caller A opens `/tmp/project.ladybug`, Caller A calls `close()` → Database is closed. Caller B then opens the same path → B succeeds (no bug, fresh open)
- Caller A opens `/tmp/a.ladybug`, Caller B opens `/tmp/b.ladybug` → both succeed (different paths, no conflict)
- Caller A opens path, Caller B opens same path, A calls `close()` → Database is destroyed, B's connection is now invalid (expected: Database stays alive until B also closes)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Retry logic with exponential backoff (200ms, 400ms) on cache miss (new `dbPath`) must continue to work identically
- `DatabaseConnectionError` with `dbPath` and `cause` must still be thrown after 3 exhausted attempts on a new `dbPath`
- Different `dbPath` values must produce separate `Database` instances
- The returned `LadybugConnection` must still expose `database`, `connection`, and `dbPath` properties
- The `SleepFn` dependency-injection seam must remain for testability

**Scope:**
All inputs where `dbPath` has no existing cached `Database` (cache miss) should behave identically to the current implementation. Only cache-hit paths and `close()` semantics change.

## Hypothesized Root Cause

1. **No connection caching**: `createLadybugConnection` unconditionally calls `new Database(dbPath)` on every invocation — no check for an existing open `Database` at the same path
2. **Unconditional close**: `close()` immediately destroys both `Connection` and `Database`, with no awareness of other consumers sharing the same `Database`
3. **Kùzu file locking**: Kùzu enforces single-process exclusive access to the database file, so a second `new Database(samePath)` fails while the first is open

## Correctness Properties

Property 1: Bug Condition - Shared Database for Same dbPath

_For any_ set of N concurrent calls to `createLadybugConnection` with the same `dbPath` (where N ≥ 2), the fixed function SHALL return N distinct `LadybugConnection` objects that all reference the same underlying `Database` instance, and `new Database()` SHALL be called exactly once for that `dbPath`.

**Validates: Requirements 2.1, 2.2**

Property 2: Preservation - Unchanged Behavior for Cache Miss

_For any_ call to `createLadybugConnection` with a `dbPath` that has no cached `Database`, the fixed function SHALL create a new `Database` with retry logic and exponential backoff identical to the original implementation, and SHALL throw `DatabaseConnectionError` after 3 exhausted attempts, preserving all existing retry and error behavior.

**Validates: Requirements 3.1, 3.2, 3.3, 3.5**

Property 3: Bug Condition - Reference-Counted Close

_For any_ `dbPath` with N open connections (N ≥ 2), calling `close()` on one connection SHALL decrement the reference count but SHALL NOT close the underlying `Database`. The `Database` SHALL only be closed when the last connection calls `close()` (refCount reaches 0).

**Validates: Requirements 2.3, 2.4**

## Fix Implementation

### Changes Required

**File**: `src/db/connection.ts`

**Specific Changes**:
1. **Add module-level cache**: Declare `const connectionCache = new Map<string, { database: Database; refCount: number }>()` at module scope
2. **Cache lookup on entry**: At the start of `createLadybugConnection`, check if `connectionCache.has(dbPath)`. If yes, increment `refCount`, create a new `Connection` on the cached `Database`, and return immediately (skip retry loop)
3. **Cache population on miss**: After successfully creating a new `Database` (inside the retry loop), store `{ database, refCount: 1 }` in the cache before returning
4. **Reference-counted close**: Replace the unconditional `close()` with logic that decrements `refCount`. Only call `database.close()` and `connectionCache.delete(dbPath)` when `refCount` reaches 0. Always close the caller's `Connection`.
5. **Export `resetConnectionCache`**: Add `export function resetConnectionCache(): void` that clears the cache — used only in tests to ensure isolation between test cases

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Confirm the bug BEFORE implementing the fix.

**Test Cases**:
1. **Double open**: Call `createLadybugConnection` twice with same `dbPath`, assert `Database` constructor called twice (demonstrates bug)
2. **Close invalidation**: Open two connections to same path, close first, verify second's `Database` is also closed (demonstrates bug)

**Expected Counterexamples**: `Database` constructor called N times for N same-path calls; `close()` on one connection destroys the shared `Database`.

### Fix Checking

**Goal**: Verify that for all buggy inputs, the fixed function produces correct behavior.

```
FOR ALL dbPath, N WHERE N >= 2 DO
  conns := [createLadybugConnection(dbPath) for i in 1..N]
  ASSERT all conns[i].database === conns[0].database
  ASSERT Database constructor called once for dbPath
  close(conns[0]); ASSERT conns[1].database still open
  close(conns[1..N]); ASSERT database.close() called once
END FOR
```

### Preservation Checking

**Goal**: Verify cache-miss path is identical to original.

```
FOR ALL dbPath WHERE NOT connectionCache.has(dbPath) DO
  ASSERT createLadybugConnection_fixed(dbPath) == createLadybugConnection_original(dbPath)
END FOR
```

**Testing Approach**: The existing test suite in `connection.test.ts` covers all cache-miss behavior. These tests must continue to pass unchanged, serving as the preservation check.

### Unit Tests

- Two calls with same `dbPath` share one `Database` instance
- `close()` with remaining references does not close `Database`
- Final `close()` closes `Database` and removes from cache
- `resetConnectionCache()` clears the cache
- Different `dbPath` values create separate `Database` instances

### Property-Based Tests

- Generate random open/close sequences on a set of `dbPath` values; verify refCount ≥ 0, `Database.close()` called exactly once per `dbPath` when all refs released, `Database` constructor called once per unique `dbPath`

### Integration Tests

- `LadybugDatabaseAdapter` calling `createLadybugConnection` multiple times with same config path
- `resetConnectionCache()` enables clean test isolation
