# Implementation Plan

- [x] 1. Write bug condition exploration test
  _Skills: `testing-patterns`, `tdd-workflow`
  - **Property 1: Bug Condition** - Concurrent Sessions + Zombie on Disconnect
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope to two concrete failing cases: (a) two concurrent `executeGetSymbolContext` calls, (b) simulated disconnect mid-call
  - Use mocked Neo4j sessions that record open/close calls via `vi.mock`
  - Case A — concurrent race: dispatch two `executeGetSymbolContext` calls concurrently; assert `openCount` reaches 2 simultaneously (isBugCondition: concurrentOpenSessions >= 1)
  - Case B — zombie on disconnect: start a tool call, simulate disconnect before completion; assert session is still open (isBugCondition: openSessionCount > 0 on disconnect)
  - Run test on UNFIXED code in `src/mcp/tools.ts` (direct `driver.session()` calls)
  - **EXPECTED OUTCOME**: Test FAILS (proves the bug exists — two sessions open, zombie survives)
  - Document counterexamples found (e.g., "openCount reached 2 during concurrent calls", "session still open after disconnect")
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  _Skills: `testing-patterns`, `tdd-workflow`
  - **Property 2: Preservation** - Sequential Call Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: single `executeGetSymbolContext` call on unfixed code — session opens, query runs, session closes in `finally`, correct `MCPToolResponse` returned
  - Observe: single call that throws — session still closes in `finally`, error propagates
  - Write property-based test with `fast-check`: for any sequence of non-concurrent tool calls (isBugCondition returns false), the fixed code returns the same `MCPToolResponse` as the original
  - Use `fc.array(fc.constantFrom("get_symbol_context", "find_dependents", "trace_data_flow", "impact_analysis"), { minLength: 1, maxLength: 5 })` to generate sequential call sequences
  - Assert `session.close()` is called exactly once per call (unchanged `finally` behavior)
  - Assert error propagation is unchanged for calls that throw
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2_

- [x] 3. Implement SessionManager and wire into MCP server
  _Skills: `typescript-expert`, `nodejs-best-practices`, `clean-code`, `error-handling-patterns`

  - [x] 3.1 Create `src/mcp/session-manager.ts` with `SessionManager` class
    - Declare `_sessions: Set<Session>` registry for all open sessions on the current connection
    - Declare `_queue: Promise<void>` async mutex — each `acquire` chains onto it to serialize access
    - Implement `acquire(driver: Driver): Promise<Session>` — chains onto `_queue`, opens session via `driver.session()`, registers in `_sessions`, returns session
    - Implement `release(session: Session): Promise<void>` — closes session, removes from `_sessions`, unblocks next queued `acquire`
    - Implement `closeAll(): Promise<void>` — closes all tracked sessions via `Promise.allSettled`, clears `_sessions`; safe to call with zero open sessions
    - Implement `openCount(): number` — returns `_sessions.size`
    - Use explicit return type annotations on all public methods; no `any`
    - _Bug_Condition: isBugCondition(event) where concurrentOpenSessions >= 1 OR openSessionCount > 0 on disconnect_
    - _Expected_Behavior: acquire serializes (at most 1 active session); closeAll reduces openCount to 0_
    - _Preservation: sequential calls unaffected — acquire/release still wraps each tool call_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.2 Update `src/mcp/tools.ts` — replace direct `driver.session()` with `SessionManager`
    - Add `sessionManager: SessionManager` parameter to `executeTool` and all four private tool functions
    - Replace `const session = driver.session()` with `const session = await sessionManager.acquire(driver)` in each tool function
    - Replace `await session.close()` in each `finally` block with `await sessionManager.release(session)`
    - Keep `finally` blocks as secondary safety net (unchanged structure)
    - No `any`; update all function signatures with explicit return types
    - _Requirements: 2.1, 3.1, 3.2_

  - [x] 3.3 Update `src/mcp/server.ts` — instantiate `SessionManager` and wire disconnect hook
    - Import `SessionManager` from `./session-manager.js`
    - Instantiate `const sessionManager = new SessionManager()` after creating the driver
    - Pass `sessionManager` into `executeTool` call inside `CallToolRequestSchema` handler
    - Register disconnect handler on `StdioServerTransport`: listen for `close` event and call `await sessionManager.closeAll()` before accepting new connections
    - _Requirements: 2.2, 2.3, 2.4_

  - [x] 3.4 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Concurrent Sessions Serialized + No Zombies
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - Run bug condition exploration test from step 1 against fixed code
    - **EXPECTED OUTCOME**: Test PASSES — `openCount` stays at 1 during concurrent calls; session count is 0 after simulated disconnect
    - _Requirements: 2.1, 2.2_

  - [x] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Sequential Call Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Run preservation property tests from step 2 against fixed code
    - **EXPECTED OUTCOME**: Tests PASS — no regressions in sequential call behavior, error propagation, or session close in `finally`
    - _Requirements: 3.1, 3.2_

- [x] 4. Write unit tests for `SessionManager` in `src/mcp/session-manager.test.ts`
  _Skills: `testing-patterns`, `tdd-workflow`, `typescript-expert`
  - `acquire` opens a session via `driver.session()` and registers it (`openCount` becomes 1)
  - `release` closes the session and removes it from the registry (`openCount` returns to 0)
  - `closeAll` closes all tracked sessions and resets `openCount` to zero
  - `closeAll` is safe to call with zero open sessions (no throw)
  - `closeAll` uses `Promise.allSettled` — does not throw if one `close()` rejects
  - Serialization: two concurrent `acquire` calls — second waits for first to `release` before opening
  - Mock Neo4j `Driver` and `Session` with `vi.mock`; never make real network calls
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 5. Write property-based tests for `SessionManager` invariants
  _Skills: `testing-patterns`, `typescript-expert`
  - Use `fast-check` with `fc.assert` + `fc.property`; set `numRuns: 50` for CI speed
  - **Property: N sequential acquire/release cycles** — for any N in [1, 20], `openCount` returns 0 after all releases
  - **Property: N concurrent acquire calls** — at most 1 session is open at any instant (serialization invariant)
  - **Property: disconnect invariant** — for any sequence of disconnect events, `openCount` is always 0 after `closeAll`
  - Co-locate in `src/mcp/session-manager.test.ts` alongside unit tests
  - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 6. Write integration test — concurrent calls and simulated disconnect
  _Skills: `testing-patterns`, `nodejs-best-practices`
  - Create `tests/integration/mcp-session-manager.test.ts`
  - Full tool call flow with `SessionManager` wired into `server.ts` — verify response shape (`MCPToolResponse` with `summary`) is unchanged
  - Two concurrent tool calls via the MCP SDK — verify neither hangs and both return results
  - Simulated disconnect mid-call — verify `closeAll` is invoked and subsequent calls succeed
  - Mock Neo4j driver and PostgreSQL pool; no real network calls
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2_

- [x] 7. Checkpoint — Ensure all tests pass (original fix)
  - Run `pnpm vitest --run --reporter=basic`
  - Ensure all tests pass; ask the user if questions arise

- [x] 8. Fix `SessionManager.acquire()` race condition — synchronous `_resolveRelease` attachment
  _Skills: `typescript-expert`, `nodejs-best-practices`, `clean-code`
  - Move `_resolveRelease` attachment inside the `_queue.then()` callback, before returning the session
  - Create `nextQueue` promise before chaining so `resolveRelease` is captured in closure
  - Set `this._queue = nextQueue` synchronously after building `acquired`
  - Remove the separate `acquired.then(...)` that attached `_resolveRelease` asynchronously
  - Ensure no `any`; keep explicit return type annotations on all public methods
  - _Bug_Condition: isBugCondition where release() is called before the async .then() microtask fires_
  - _Expected_Behavior: _resolveRelease is always set by the time the caller can invoke release()_
  - _Requirements: 2.5_

- [x] 9. Fix `closeAll()` to unblock pending acquires before resetting queue
  _Skills: `typescript-expert`, `nodejs-best-practices`, `error-handling-patterns`
  - Before resetting `_queue`, call `_resolveRelease()` for every session in `_sessions` that has one set
  - Ensure waiters blocked on the old `_queue` promise are unblocked even when `closeAll()` force-closes their session
  - Keep `Promise.allSettled` for session.close() calls
  - Keep `this._queue = Promise.resolve()` reset after unblocking waiters
  - _Bug_Condition: isBugCondition where acquire() callers wait on old _queue after closeAll() resets it_
  - _Expected_Behavior: all pending acquire() waiters are unblocked before queue is reset_
  - _Requirements: 2.7_

- [x] 10. Fix multi-transaction session reuse in query functions
  _Skills: `typescript-expert`, `nodejs-best-practices`, `clean-code`, `architecture`
  - [x] 10.1 Refactor `executeContextRetrieval` in `src/query/context-retrieval.ts` to consolidate all 5 `session.executeRead()` calls into a single managed transaction block
    - Run `findNode`, `findDependents`, `findDependencies`, `findProcessesBySymbol`, `findClustersBySymbol` inside one `session.executeRead((tx) => ...)` callback
    - Update `src/graph/query.ts` functions to accept a `ManagedTransaction` parameter instead of `Session` where needed, or inline the Cypher into the single transaction block
    - _Requirements: 2.6_
  - [x] 10.2 Audit `executeImpactAnalysis` and `executeDataFlowTrace` for the same multi-`executeRead` pattern and apply the same consolidation
    - _Requirements: 2.6_

- [x] 11. Add regression tests for race condition and multi-transaction scenarios
  _Skills: `testing-patterns`, `tdd-workflow`, `typescript-expert`
  - [x] 11.1 Write deterministic race condition test for `SessionManager.acquire()`
    - Use controlled microtask interleaving: call `release()` before yielding to microtask queue
    - Assert `_resolveRelease` is called on fixed code (queue unblocked)
    - Assert a second `acquire()` resolves after `release()` (serialization preserved)
    - Co-locate in `src/mcp/session-manager.test.ts`
    - _Requirements: 2.5_
  - [x] 11.2 Write test for `closeAll()` unblocking pending acquires
    - Start an `acquire()`, do NOT release, call `closeAll()`
    - Assert the pending `acquire()` resolves (not hangs) after `closeAll()`
    - _Requirements: 2.7_
  - [x] 11.3 Write test for single-transaction consolidation in `executeContextRetrieval`
    - Mock Neo4j session to throw on second `executeRead()` call
    - Assert fixed code never triggers the second `executeRead()` error
    - _Requirements: 2.6_

- [x] 12. Checkpoint — run all tests
  - Run `pnpm vitest --run --reporter=basic`
  - Ensure all tests pass; ask the user if questions arise

