# MCP Session Stuck Transaction — Bugfix Design

## Overview

The MCP server creates a single shared Neo4j `Driver` at startup. Each of the four tool
handlers in `src/mcp/tools.ts` independently calls `driver.session()` with no coordination.
Because the MCP SDK dispatches tool calls concurrently, multiple sessions can run in parallel
on the same driver, causing overlapping transactions that deadlock or block each other in
Neo4j. Additionally, when the MCP client disconnects mid-call, the interrupted session is
never closed — its transaction remains open as a "zombie". On reconnect the same driver is
reused, so new queries contend with those zombie transactions.

The fix introduces a `SessionManager` in `src/mcp/session-manager.ts` that:
1. Tracks every open Neo4j session for the current connection.
2. Serializes session acquisition per connection (one active session at a time) to prevent
   transaction interleaving.
3. Closes all tracked sessions when the transport disconnects, eliminating zombies before
   the next connection is accepted.

The existing `finally { session.close() }` blocks in each tool handler are kept as a
secondary safety net.

## Glossary

- **Bug_Condition (C)**: Two or more tool calls dispatched concurrently on the same MCP
  connection, OR a reconnect event where prior sessions were not closed.
- **Property (P)**: For any input where C holds, the fixed system SHALL coordinate session
  access (no deadlock) and close all sessions on disconnect (no zombies).
- **Preservation**: All single-call, non-concurrent, non-disconnect behaviors must remain
  identical to the original implementation.
- **SessionManager**: New class in `src/mcp/session-manager.ts` that owns session lifecycle.
- **zombie transaction**: A Neo4j session/transaction left open after its originating MCP
  connection was interrupted or closed.
- **executeTool**: The function in `src/mcp/tools.ts` that dispatches to one of four query
  handlers, each of which opens a `driver.session()`.
- **onDisconnect**: The transport-level event fired when the MCP client disconnects.

## Bug Details

### Bug Condition

The bug manifests when (a) two or more tool calls arrive concurrently on the same MCP
connection, or (b) the MCP client disconnects while a tool call is in flight. In case (a)
multiple `driver.session()` calls run in parallel with no coordination, allowing their
transactions to interleave and deadlock. In case (b) the `finally` block is never reached
after the async cancellation, leaving the session open.

**Formal Specification:**
```
FUNCTION isBugCondition(event)
  INPUT: event — either a ToolCallEvent or a DisconnectEvent
  OUTPUT: boolean

  IF event IS ToolCallEvent THEN
    RETURN concurrentOpenSessions(event.connectionId) >= 1
           // a second call arrives while one is already in flight
  END IF

  IF event IS DisconnectEvent THEN
    RETURN openSessionCount(event.connectionId) > 0
           // sessions were left open when the connection closed
  END IF

  RETURN false
END FUNCTION
```

### Examples

- Two concurrent `get_symbol_context` calls open two sessions simultaneously → Neo4j
  deadlock; both calls hang indefinitely. (Bug condition: concurrent sessions >= 1)
- Client disconnects mid `trace_data_flow` → session never closed → zombie transaction
  blocks the next `find_dependents` call after reconnect. (Bug condition: open sessions > 0
  on disconnect)
- Three rapid reconnect cycles each interrupted mid-call → three zombie transactions
  accumulate → Neo4j lock limit reached → all subsequent queries fail. (Bug condition:
  cumulative open sessions > 0 across cycles)
- Single sequential call completes normally → `finally` closes session → no bug.
  (isBugCondition returns false)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- A single tool call that completes successfully MUST still close its Neo4j session in the
  `finally` block and return the correct `MCPToolResponse`.
- A tool call that throws an error during normal operation (no disconnect, no concurrency)
  MUST still close its session in the `finally` block and propagate the error.
- Server startup MUST still establish the Neo4j driver and PostgreSQL pool and register all
  four MCP tools successfully.
- Valid tool calls on an established connection MUST still execute and return results within
  existing performance targets (simple queries < 500 ms, complex traversals < 2 s).

**Scope:**
All inputs that do NOT involve concurrent sessions or a disconnect event are completely
unaffected by this fix. This includes:
- Sequential (non-overlapping) tool calls
- Tool calls that throw errors without a disconnect
- Mouse/keyboard interactions in the AI editor that do not trigger concurrent calls
- Any non-Neo4j code paths (PostgreSQL pool, auth, validation)

## Confirmed Additional Root Causes (Post-Fix Investigation)

The original fix was deployed but the bug persists. Three additional root causes were found:

### Root Cause A — `acquire()` race: `_resolveRelease` attached asynchronously

The current `acquire()` attaches `_resolveRelease` to the session via a `.then()` callback:

```typescript
acquired.then((session) => {
  (session as Session & { _resolveRelease: () => void })._resolveRelease = resolveRelease;
});
```

This runs in a future microtask. If `release()` is called before that microtask fires
(possible when a query completes very quickly), `_resolveRelease` is `undefined` and the
queue is permanently blocked.

**Fix**: Move the attachment inside the `_queue.then()` callback, synchronously, before
returning the session:

```typescript
const acquired = this._queue.then(() => {
  const session = driver.session();
  this._sessions.add(session);
  (session as Session & { _resolveRelease: () => void })._resolveRelease = resolveRelease;
  return session;
});
this._queue = nextQueue;
```

### Root Cause B — Multiple `session.executeRead()` calls per session

`executeContextRetrieval` (and similar functions) makes 5 sequential `session.executeRead()`
calls on the same session. In Neo4j driver v5+, if a prior `executeRead()` transaction was
not cleanly committed/rolled back, the next call throws:
`"You cannot begin a transaction on a session with an open transaction"`.

**Fix**: Consolidate all reads for a single tool call into one `session.executeRead()`
transaction block. Each query function should run all its Cypher statements inside a single
managed transaction, removing the possibility of a stuck intermediate transaction.

### Root Cause C — `closeAll()` doesn't unblock pending acquires

`closeAll()` resets `_queue = Promise.resolve()` but callers already waiting on the *old*
`_queue` promise remain blocked forever — their `_resolveRelease` was never called (made
worse by Root Cause A).

**Fix**: Before resetting `_queue`, call `resolveRelease()` for every session being closed
so all pending `acquire()` waiters are unblocked.

## Hypothesized Root Cause

1. **No session coordination in `tools.ts`**: Each of the four tool functions calls
   `driver.session()` independently. There is no mutex, queue, or pool limiting how many
   sessions can be open simultaneously. The MCP SDK's concurrent dispatch means all four
   handlers can open sessions at the same time.

2. **No disconnect hook in `server.ts`**: `startMCPServer` connects the transport but never
   registers a handler for the transport's `close` or `disconnect` event. When the client
   drops, in-flight async calls are abandoned and their `finally` blocks are never reached
   because the Node.js event loop moves on without awaiting them.

3. **Shared driver with no session registry**: The `Driver` instance is created once and
   passed directly to `executeTool`. There is no registry of open sessions, so there is
   nothing to iterate over and close on disconnect.

4. **`finally` block insufficient for async cancellation**: The `finally { session.close() }`
   pattern works for normal completion and thrown errors, but does not fire when the
   surrounding async context is abandoned (e.g. the transport closes and the SDK stops
   awaiting the handler's promise).

## Correctness Properties

Property 1: Bug Condition — Concurrent Sessions Are Serialized

_For any_ pair of tool calls dispatched concurrently on the same MCP connection where
isBugCondition returns true (concurrentOpenSessions >= 1), the fixed `SessionManager.acquire`
SHALL queue the second call until the first session is released, ensuring at most one active
Neo4j session per connection at any time and preventing transaction interleaving.

**Validates: Requirements 2.1**

Property 2: Preservation — Disconnect Closes All Sessions

_For any_ disconnect event where isBugCondition returns true (openSessionCount > 0), the
fixed `SessionManager.closeAll` SHALL close every tracked session before the connection is
considered terminated, reducing the open session count to zero and leaving no zombie
transactions in Neo4j.

**Validates: Requirements 2.2, 2.3, 2.4**

Property 3: Fix Checking — `_resolveRelease` Is Always Set Before `release()` Can Be Called

_For any_ `acquire()` call, the fixed implementation SHALL attach `_resolveRelease`
synchronously inside the `_queue.then()` callback so that by the time the returned promise
resolves and the caller can invoke `release()`, `_resolveRelease` is guaranteed to be set.
No microtask scheduling window exists where `release()` can observe `_resolveRelease` as
`undefined`.

**Validates: Requirements 2.5**

Property 4: Fix Checking — Single `executeRead()` Transaction Per Tool Call

_For any_ query function invocation, the fixed implementation SHALL execute all Cypher
reads within a single `session.executeRead()` managed transaction, ensuring the Neo4j
driver never encounters a second `executeRead()` call on a session with an open transaction.

**Validates: Requirements 2.6**

Property 5: Fix Checking — `closeAll()` Unblocks All Pending Acquires

_For any_ `closeAll()` call where N `acquire()` calls are waiting on the queue, the fixed
`closeAll()` SHALL call `resolveRelease()` for each session being closed before resetting
`_queue`, ensuring all N waiters are unblocked and no caller hangs after `closeAll()`.

**Validates: Requirements 2.7**

## Fix Implementation

### Changes Required

**New File**: `src/mcp/session-manager.ts`

A `SessionManager` class that:
- Holds a `Set<Session>` of all open sessions for the current connection.
- Exposes `acquire(driver): Promise<Session>` — opens a session, registers it, and uses an
  internal async mutex (a promise chain) to serialize access.
- Exposes `release(session): Promise<void>` — closes the session and removes it from the
  registry, then unblocks the next queued `acquire` call.
- Exposes `closeAll(): Promise<void>` — closes every tracked session in parallel
  (`Promise.allSettled`) and clears the registry; called on disconnect.
- Exposes `openCount(): number` — returns the current registry size (for testing).

**Modified File**: `src/mcp/tools.ts`

Replace the direct `driver.session()` calls in all four tool functions with
`sessionManager.acquire(driver)` / `sessionManager.release(session)` so that session
lifecycle is managed by `SessionManager`.

**Modified File**: `src/mcp/server.ts`

1. Instantiate a `SessionManager` after creating the driver.
2. Pass the `SessionManager` into `executeTool` (or thread it through the call chain).
3. Register a disconnect handler on the `StdioServerTransport` (or wrap the transport) that
   calls `sessionManager.closeAll()` before the server accepts new connections.

### Specific Changes

1. **Async mutex in `SessionManager`**: Maintain a `_queue: Promise<void>` that each
   `acquire` call chains onto, ensuring sequential session access per connection.
2. **Session registry**: Use a `Set<Session>` so `closeAll` can iterate and close all open
   sessions even if `release` was never called (interrupt scenario).
3. **`closeAll` uses `Promise.allSettled`**: Ensures all sessions are attempted even if one
   `close()` throws.
4. **Transport disconnect hook**: Listen for the `close` event on the transport (or override
   `server.close`) to trigger `sessionManager.closeAll()`.
5. **Tool function signatures**: Add `sessionManager: SessionManager` parameter to
   `executeTool` and each private tool function; remove direct `driver.session()` calls.

## Testing Strategy

### Validation Approach

Two-phase approach: first surface counterexamples on unfixed code to confirm root cause,
then verify the fix and preservation on fixed code.

### Exploratory Bug Condition Checking

**Goal**: Demonstrate the bug on unfixed code — confirm that concurrent `driver.session()`
calls interleave and that sessions survive a simulated disconnect.

**Test Plan**: Use mocked Neo4j sessions that record open/close calls. Dispatch two
concurrent tool calls and assert that two sessions are open simultaneously (proving the
race). Simulate a disconnect mid-call and assert the session is still open (proving the
zombie).

**Test Cases**:
1. **Concurrent session race**: Dispatch two `executeGetSymbolContext` calls concurrently on
   unfixed code; assert `openCount` reaches 2 simultaneously. (will fail on fixed code —
   count stays at 1)
2. **Zombie on disconnect**: Start a tool call, simulate disconnect before it completes;
   assert session is still open on unfixed code. (will pass on fixed code — `closeAll`
   closes it)
3. **Reconnect accumulation**: Three interrupted calls; assert three sessions remain open on
   unfixed code. (will pass on fixed code — each disconnect triggers `closeAll`)
4. **Out-of-range / no-op**: Disconnect with no open sessions; assert `closeAll` is a no-op
   and does not throw.

**Expected Counterexamples**:
- On unfixed code: `openCount` reaches 2+ during concurrent calls.
- On unfixed code: session remains open after simulated disconnect.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed
`SessionManager` produces the expected behavior.

**Pseudocode:**
```
FOR ALL event WHERE isBugCondition(event) DO
  result := sessionManager_fixed.handle(event)
  ASSERT openCount(result) <= 1          // serialization holds
  IF event IS DisconnectEvent THEN
    ASSERT openCount(result) === 0       // no zombies
  END IF
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed code
produces the same result as the original.

**Pseudocode:**
```
FOR ALL event WHERE NOT isBugCondition(event) DO
  ASSERT original_behavior(event) === fixed_behavior(event)
END FOR
```

**Testing Approach**: Property-based testing with `fast-check` is used for preservation
because it generates many sequential call scenarios automatically, catching edge cases that
manual tests miss.

**Test Cases**:
1. **Sequential call preservation**: For any sequence of non-concurrent tool calls, the
   fixed code returns the same `MCPToolResponse` as the original.
2. **Error propagation preservation**: For any tool call that throws, the fixed code still
   closes the session and propagates the same error.
3. **Session close in finally**: Verify `session.close()` is called exactly once per
   successful call (unchanged behavior).

### Testing Strategy for Race Condition (Root Cause A)

The `_resolveRelease` race requires precise timing control to reproduce reliably. Use a
controlled microtask interleaving approach:

1. Create a deferred promise that resolves the `_queue` only after a manual trigger.
2. Call `acquire()` and immediately call `release()` on the returned session *before*
   yielding to the microtask queue (using `queueMicrotask` or `Promise.resolve().then()`).
3. Assert that `_resolveRelease` was called (queue unblocked) on the fixed code.
4. Assert that `_resolveRelease` was NOT called (queue blocked) on the unfixed code.

This avoids flaky timing-dependent tests by making the race deterministic.

### Testing Strategy for Multi-Transaction (Root Cause B)

Mock the Neo4j session to throw `"You cannot begin a transaction on a session with an open
transaction"` on the second `executeRead()` call. Verify the fixed single-transaction
approach never triggers this error path.

- `SessionManager.acquire` opens a session and registers it.
- `SessionManager.release` closes the session and removes it from the registry.
- `SessionManager.closeAll` closes all tracked sessions and resets count to zero.
- `SessionManager` serializes two concurrent `acquire` calls (second waits for first).
- `closeAll` is safe to call with zero open sessions.
- `closeAll` uses `Promise.allSettled` — does not throw if one `close()` rejects.

### Property-Based Tests

- For any N sequential acquire/release cycles, `openCount` returns 0 after all releases.
- For any N concurrent acquire calls, at most 1 session is open at any instant.
- For any sequence of disconnect events, `openCount` is always 0 after `closeAll`.

### Integration Tests

- Full tool call flow with `SessionManager` wired into `server.ts` — verify response shape
  is unchanged.
- Simulated disconnect mid-call — verify `closeAll` is invoked and subsequent calls succeed.
- Two concurrent tool calls via the MCP SDK — verify neither hangs and both return results.
