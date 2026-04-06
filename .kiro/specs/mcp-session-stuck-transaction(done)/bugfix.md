# Bugfix Requirements Document

## Introduction

The MCP server uses a single shared Neo4j `Driver` instance created once at startup
(`src/mcp/server.ts`). Each tool call in `src/mcp/tools.ts` independently opens a new
`driver.session()` with no coordination. Two compounding problems arise: (1) the MCP SDK
dispatches tool calls concurrently, so multiple sessions run in parallel on the same driver
and can produce overlapping transactions that deadlock or get stuck; (2) when the MCP client
reconnects, the same driver is reused but any sessions from the prior connection that were
interrupted mid-call are never closed — their transactions remain open in Neo4j as "zombie"
transactions. New queries on the reconnected client then contend with those zombie
transactions, causing lock timeouts or indefinite blocking.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN two or more tool calls are dispatched concurrently on the same MCP connection THEN
the system opens multiple `driver.session()` instances in parallel with no coordination,
allowing their transactions to interleave and deadlock or block each other in Neo4j.

1.2 WHEN a tool call is interrupted mid-execution (e.g. the MCP client disconnects or the
async call is cancelled) THEN the system leaves the Neo4j session open with an uncommitted
transaction, because the `finally { session.close() }` block is never reached after the
interruption.

1.3 WHEN the MCP client reconnects after a previous connection that had in-flight tool calls
THEN the system reuses the same `Driver` instance without closing the orphaned sessions from
the prior connection, so new queries contend with those zombie transactions and block or
return lock-timeout errors.

1.4 WHEN multiple reconnect cycles occur in sequence THEN the system accumulates one zombie
transaction per interrupted tool call, progressively degrading query performance until Neo4j
exhausts its transaction or lock limit.

### Expected Behavior (Correct)

2.1 WHEN two or more tool calls are dispatched concurrently on the same MCP connection THEN
the system SHALL coordinate Neo4j session access so that concurrent transactions do not
produce deadlocks — either by serializing access per connection or by using a session pool
that limits parallel transactions.

2.2 WHEN a tool call is interrupted mid-execution THEN the system SHALL close the associated
Neo4j session and roll back its transaction before the connection is considered terminated.

2.3 WHEN the MCP client reconnects THEN the system SHALL close all sessions that were opened
on the previous connection before accepting new tool calls, ensuring no zombie transactions
remain in Neo4j.

2.4 WHEN multiple reconnect cycles occur in sequence THEN the system SHALL release all Neo4j
sessions from each prior connection, keeping the number of open transactions at zero between
connections.

### Newly Discovered Root Causes (Post-Fix Investigation)

The original fix (SessionManager with async mutex) was implemented but the bug persists in
production. Deep investigation revealed three additional root causes:

**Root Cause A — Race condition in `SessionManager.acquire()`: `_resolveRelease` attachment is async**

1.5 WHEN `acquire()` is called and the acquired session's query completes before the
`.then()` microtask that attaches `_resolveRelease` fires THEN the system leaves
`_resolveRelease` as `undefined` on the session object, so `release()` never calls it and
the `_queue` promise never resolves — permanently blocking all subsequent `acquire()` calls.

**Root Cause B — Multiple `session.executeRead()` calls on the same session**

1.6 WHEN a query function (e.g. `executeContextRetrieval`) makes multiple sequential
`session.executeRead()` calls on the same session AND a prior `executeRead()` transaction
was not cleanly committed or rolled back (e.g. due to a network hiccup or driver-internal
state issue) THEN the Neo4j driver v5+ throws `"You cannot begin a transaction on a session
with an open transaction"`, leaving the session stuck.

**Root Cause C — `closeAll()` does not unblock pending acquires**

1.7 WHEN `closeAll()` is called while one or more `acquire()` calls are waiting on the old
`_queue` promise THEN the system resets `_queue` to a new resolved promise but the waiting
callers remain blocked on the old promise forever, because `_resolveRelease` was never
called for the force-closed session (compounded by Root Cause A).

### Expected Behavior (Correct) — Addendum

2.5 WHEN `acquire()` is called THEN the system SHALL attach `_resolveRelease` synchronously
inside the `_queue.then()` callback (before returning the session) so that `release()` can
always unblock the queue regardless of microtask scheduling.

2.6 WHEN a query function performs multiple graph reads for a single tool call THEN the
system SHALL consolidate all reads into a single `session.executeRead()` transaction block,
eliminating the possibility of a stuck intermediate transaction.

2.7 WHEN `closeAll()` is called with pending `acquire()` waiters THEN the system SHALL
resolve all outstanding `_resolveRelease` functions for sessions being closed so that
waiting callers are unblocked before the queue is reset.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a tool call completes successfully on an established connection with no concurrent
calls THEN the system SHALL CONTINUE TO close the Neo4j session in the `finally` block and
return the correct `MCPToolResponse` to the client.

3.2 WHEN a tool call throws an error during normal operation (no disconnect, no concurrency)
THEN the system SHALL CONTINUE TO close the Neo4j session in the `finally` block and
propagate the error response to the client.

3.3 WHEN the MCP server starts for the first time THEN the system SHALL CONTINUE TO
establish the Neo4j driver and PostgreSQL pool and register all four MCP tools successfully.

3.4 WHEN the MCP client sends a valid tool call on an established connection THEN the system
SHALL CONTINUE TO execute the query and return results within the existing performance
targets (simple queries < 500 ms, complex traversals < 2 s).
