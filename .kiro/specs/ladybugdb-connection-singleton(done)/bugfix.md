# Bugfix Requirements Document

## Introduction

The `createLadybugConnection` function in `src/db/connection.ts` creates a new `Database` instance on every invocation, even when called with the same `dbPath`. Because Kùzu (the embedded graph database behind LadybugDB) only allows a single process to hold a database file open at a time, concurrent intra-process consumers — such as the MCP server, CLI indexer, and query server — fail with `"Failed to connect to LadybugDB at <path>"` after exhausting all 3 retry attempts. The root cause is the absence of any singleton/caching mechanism in the connection factory.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN multiple callers within the same process invoke `createLadybugConnection` with the same `dbPath` concurrently THEN the system creates a separate `Database` instance for each call, causing later connections to fail with a `DatabaseConnectionError` after exhausting all 3 retry attempts

1.2 WHEN a second caller invokes `createLadybugConnection` with a `dbPath` that already has an open `Database` instance in the same process THEN the system attempts to open a duplicate `Database` on the same file, which Kùzu rejects because the file is already locked

1.3 WHEN any caller invokes `close()` on a `LadybugConnection` THEN the system unconditionally closes both the `Connection` and the underlying `Database`, potentially invalidating other active connections sharing the same `dbPath`

### Expected Behavior (Correct)

2.1 WHEN multiple callers within the same process invoke `createLadybugConnection` with the same `dbPath` concurrently THEN the system SHALL return a new `Connection` wrapping a single shared `Database` instance for that `dbPath`, and all callers SHALL succeed without connection errors

2.2 WHEN a second caller invokes `createLadybugConnection` with a `dbPath` that already has an open `Database` instance in the same process THEN the system SHALL reuse the existing `Database` instance and return a new `Connection` wrapping it, without attempting to open a duplicate `Database`

2.3 WHEN a caller invokes `close()` on a `LadybugConnection` THEN the system SHALL decrement the reference count for that `dbPath` and only actually close the underlying `Database` when the last reference is released (reference count reaches zero)

2.4 WHEN all connections for a given `dbPath` have been closed (reference count reaches zero) THEN the system SHALL close the underlying `Database` and remove it from the cache, allowing a fresh `Database` to be created on subsequent calls

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `createLadybugConnection` is called with a `dbPath` that has no existing cached `Database` THEN the system SHALL CONTINUE TO create a new `Database` instance at that path with retry logic and exponential backoff (up to 3 attempts with 200ms/400ms delays)

3.2 WHEN all retry attempts are exhausted for a new `dbPath` THEN the system SHALL CONTINUE TO throw a `DatabaseConnectionError` containing the `dbPath` and the underlying cause

3.3 WHEN `createLadybugConnection` is called with different `dbPath` values THEN the system SHALL CONTINUE TO create separate `Database` instances for each distinct path

3.4 WHEN `close()` is called and it is the last reference for that `dbPath` THEN the system SHALL CONTINUE TO close both the `Connection` and the `Database`, matching the current teardown behavior

3.5 WHEN the `LadybugConnection` is used after creation THEN the system SHALL CONTINUE TO expose `database`, `connection`, and `dbPath` properties on the returned object
