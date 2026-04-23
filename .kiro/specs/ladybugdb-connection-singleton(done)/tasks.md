# Implementation Plan

- [x] 1. Write bug condition exploration test
  _Skills: `testing-patterns`, `tdd-workflow`
  - **Property 1: Bug Condition** - Duplicate Database Instantiation for Same dbPath
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate duplicate `Database` instantiation and broken `close()` semantics
  - **Scoped PBT Approach**: Scope the property to concrete failing cases: two calls to `createLadybugConnection` with the same `dbPath`
  - Create test file `src/db/connection-singleton.test.ts` with `fast-check` property tests
  - Property: for any `dbPath`, calling `createLadybugConnection(dbPath)` twice should return connections sharing the same `Database` instance (`conn1.database === conn2.database`) and `Database` constructor should be called exactly once
  - Property: for any `dbPath` with 2 open connections, calling `close()` on the first should NOT close the underlying `Database` (second connection remains valid)
  - Use mocked `@ladybugdb/core` (same pattern as `connection.test.ts`) with `instantSleep`
  - Run test on UNFIXED code — expect FAILURE (Database constructor called twice, close destroys shared Database)
  - Document counterexamples: `createLadybugConnection("/tmp/x.ladybug")` called twice → `Database` constructed twice; `close()` on first → `database.close()` called, invalidating second
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  _Skills: `testing-patterns`, `tdd-workflow`
  - **Property 2: Preservation** - Cache-Miss Retry and Error Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe on UNFIXED code: single-call path creates `Database`, retries with exponential backoff, throws `DatabaseConnectionError` after 3 failures
  - Observe: returned `LadybugConnection` exposes `database`, `connection`, `dbPath` properties
  - Observe: different `dbPath` values produce separate `Database` instances
  - Write property-based tests in `src/db/connection-singleton.test.ts` (separate `describe` block):
    - Property: for any single `dbPath` (cache miss), `createLadybugConnection` creates a `Database`, calls `init()`, creates a `Connection`, and returns object with `database`, `connection`, `dbPath`
    - Property: for any two distinct `dbPath` values, separate `Database` instances are created
    - Property: when `Database.init()` fails all 3 attempts, `DatabaseConnectionError` is thrown with correct `dbPath` and `cause`
  - Verify tests PASS on UNFIXED code (these cover non-bug-condition behavior)
  - _Requirements: 3.1, 3.2, 3.3, 3.5_

- [x] 3. Implement singleton connection cache with reference counting
  _Skills: `typescript-expert`, `clean-code`, `error-handling-patterns`

  - [x] 3.1 Implement the fix in `src/db/connection.ts`
    - Add module-level `connectionCache: Map<string, { database: Database; refCount: number }>`
    - At start of `createLadybugConnection`, check `connectionCache.has(dbPath)` — if hit, increment `refCount`, create new `Connection` on cached `Database`, return immediately (skip retry loop)
    - On cache miss (new `dbPath`), after successful `Database` creation in retry loop, store `{ database, refCount: 1 }` in cache
    - Replace unconditional `close()` with reference-counted logic: decrement `refCount`, always close caller's `Connection`, only call `database.close()` and `connectionCache.delete(dbPath)` when `refCount` reaches 0
    - Export `resetConnectionCache(): void` that clears the cache (for test isolation)
    - _Bug_Condition: isBugCondition(input) where input.existingOpenDatabase == true AND createLadybugConnection(input.dbPath) is called_
    - _Expected_Behavior: all callers for same dbPath share one Database; each gets own Connection; close() is reference-counted_
    - _Preservation: retry logic, DatabaseConnectionError on exhaustion, separate Database per distinct dbPath, LadybugConnection interface shape unchanged_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 3.2 Update existing tests to use `resetConnectionCache`
    - Import `resetConnectionCache` in `src/db/connection.test.ts`
    - Add `resetConnectionCache()` call in the existing `beforeEach` block to ensure test isolation
    - Verify all existing tests in `connection.test.ts` still pass
    - _Requirements: 3.1, 3.2, 3.3, 3.5_

  - [x] 3.3 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Shared Database for Same dbPath
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior (shared Database, reference-counted close)
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.4 Verify preservation tests still pass
    - **Property 2: Preservation** - Cache-Miss Retry and Error Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 4. Checkpoint — Ensure all tests pass
  - Run `pnpm vitest --run src/db/` to execute all db tests
  - Verify `connection.test.ts` (existing tests) all pass
  - Verify `connection-singleton.test.ts` (bug condition + preservation) all pass
  - Ensure all tests pass, ask the user if questions arise
