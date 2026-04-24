# Implementation Plan: LadybugDB Connection Server

**Related documents:**
- [Client & Adapter Tasks](./tasks-client.md)
- [Testing Tasks](./tasks-testing.md)

## Overview

Implements a standalone gRPC connection server that owns the single LadybugDB instance per `dbPath`, with client-backed adapters for MCP/CLI/query processes. Tasks follow the migration phases from the architectural spec.

## Tasks

- [x] 1. Configuration, types, and error classes (Phase 0)
  _Skills: `typescript-expert`, `error-handling-patterns`
  - [x] 1.1 Extend `FullConfig` in `src/config/types.ts` with server/client fields (`runtimeMode`, `serverUrl`, `serverHost`, `serverPort`, `serverAuthToken`, `serverMaxConcurrency`, `serverMaxQueue`, `serverAutostart`, `serverStartupTimeoutMs`, `serverLockPath`, `serverDiscoveryPath`, `serverIdleTtlMs`)
    - Add `LadybugRuntimeMode` type and `LadybugServerConfig` / `LadybugClientConfig` interfaces
    - _Requirements: 1.1, 1.2_
  - [x] 1.2 Add environment variable parsing and validation for all new config fields in `src/config/`
    - Validate `port` 1–65535, `maxConcurrency >= 1`, `maxQueue >= 1`, `serverUrl` must be valid `grpc://` URL in client mode
    - Apply documented defaults from design-data-models.md
    - _Requirements: 1.2, 1.3, 1.4_
  - [x] 1.3 Create `src/db-server/types.ts` with `RequestMetadata`, `ErrorDetail`, `DiscoveryFile`, `RequestPriority`, `ScheduledRequest`, `SchedulerStats`, `ServerMetrics` interfaces
    - _Requirements: 3.1, 4.1_
  - [x] 1.4 Create error classes in `src/db-server/errors.ts`: `ServerUnavailableError`, `ServerStartupTimeoutError`, `QueueFullError`, `RequestTimeoutError`, `ServerDrainingError`
    - Each error must include the constructor args and gRPC status mapping from design-data-models.md
    - _Requirements: 4.3, 4.5, 7.4, 7.7_

- [x] 2. EmbeddedDatabaseRuntime and gRPC server skeleton (Phase 1)
  _Skills: `typescript-expert`, `nodejs-best-practices`, `architecture`
  - [x] 2.1 Create `src/db-server/runtime.ts` implementing `EmbeddedDatabaseRuntime` interface
    - Wrap `createLadybugConnection()`, expose `open(dbPath, prefix)`, `getConnection()`, `getDatabase()`, `close()`, `isHealthy()`
    - `open()` acquires file lock and initializes schema; `close()` flushes WAL and releases lock
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [x] 2.2 Create `proto/ladybug_connection.proto` with Health, Admin, Graph, and Vector service definitions
    - Define all request/response messages per design-data-models.md
    - Include `RequestMetadata` fields on all operation requests
    - _Requirements: 3.1, 3.2, 3.3, 3.4_
  - [x] 2.3 Create `src/db-server/server.ts` with gRPC server setup using `@grpc/grpc-js` and `@grpc/proto-loader`
    - Bind to `config.host:config.port`, register signal handlers for SIGTERM/SIGINT
    - Implement graceful shutdown: stop accepting, drain scheduler, flush WAL, remove discovery file
    - _Requirements: 3.7, 5.3_
  - [x] 2.4 Create `src/db-server/services/health.ts` implementing `Health.Check` RPC
    - Return SERVING when runtime `isHealthy()` and scheduler is accepting
    - _Requirements: 3.1_
  - [x] 2.5 Create `src/db-server/services/admin.ts` implementing `Admin.GetMetrics` and `Admin.Shutdown` RPCs
    - GetMetrics returns queue depth, in-flight, uptime, per-endpoint latency from MetricsCollector
    - _Requirements: 3.2, 3.7_
  - [x] 2.6 Create `src/db-server/main.ts` as standalone entrypoint calling `startConnectionServer(config)`
    - Parse config, call server startup, handle fatal errors with non-zero exit
    - _Requirements: 2.4_

- [x] 3. Checkpoint — Verify server skeleton
  - Ensure the server starts, binds to the configured port, and responds to `Health.Check`. Ask the user if questions arise.

- [x] 4. Graph and Vector gRPC services with OperationRouter (Phase 2)
  _Skills: `typescript-expert`, `clean-code`, `architecture`
  - [x] 4.1 Create `src/db-server/router.ts` implementing `OperationRouter`
    - Validate payloads (return `INVALID_ARGUMENT` on failure), apply prefix context, delegate to graph/vector adapters
    - Reject requests with mismatched prefix (`INVALID_ARGUMENT`)
    - _Requirements: 3.5, 3.6, 8.1, 8.3_
  - [x] 4.2 Create `src/db-server/services/graph.ts` implementing all Graph RPCs
    - `QueryNodes`, `QueryRelationships`, `RunCypher`, `RunCypherWrite`, `CreateNode`, `CreateRelationship`, `DeleteNodesByLabel`, `DeleteRelationshipsByType`
    - Each RPC delegates through OperationRouter with appropriate priority
    - _Requirements: 3.3_
  - [x] 4.3 Create `src/db-server/services/vector.ts` implementing all Vector RPCs
    - `CreateTables`, `IndexSymbol`, `SemanticSearch`, `DeleteAll`
    - Each RPC delegates through OperationRouter with appropriate priority
    - _Requirements: 3.4_

- [x] 5. RequestScheduler with concurrency limits, priority queuing, timeouts (Phase 3)
  _Skills: `typescript-expert`, `nodejs-best-practices`, `error-handling-patterns`
  - [x] 5.1 Create `src/db-server/scheduler.ts` implementing `RequestScheduler` interface
    - Bounded priority queue (max `maxQueue`), concurrency limiter (max `maxConcurrency`)
    - Priority ordering: admin > interactive_read > background_write
    - Per-request timeout with `DEADLINE_EXCEEDED` rejection
    - `drain()`: reject new requests, wait for in-flight to complete
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - [x] 5.2 Wire RequestScheduler into OperationRouter and gRPC services
    - All Graph/Vector RPCs enqueue through scheduler before execution
    - _Requirements: 4.1, 4.4_

- [x] 6. Checkpoint — Verify full server with scheduling
  - Ensure Graph/Vector RPCs execute through the scheduler with concurrency limits. Ask the user if questions arise.
