Part of the [Implementation Plan](./tasks.md).

# Client, Adapter & Observability Tasks

## Tasks

- [x] 7. RemoteDatabaseAdapter, RemoteGraphAdapter, RemoteVectorAdapter (Phase 4)
  _Skills: `typescript-expert`, `clean-code`, `error-handling-patterns`
  - [x] 7.1 Create `src/db/remote-graph-adapter.ts` implementing `GraphAdapter`
    - Proxy all graph operations over gRPC to the connection server
    - Serialize/deserialize protobuf messages, propagate deadlines via gRPC metadata
    - _Requirements: 6.1, 6.2, 6.6, 10.1_
  - [x] 7.2 Create `src/db/remote-vector-adapter.ts` implementing `VectorAdapter`
    - Proxy all vector operations over gRPC to the connection server
    - Serialize/deserialize protobuf messages, propagate deadlines via gRPC metadata
    - _Requirements: 6.1, 6.2, 6.6, 10.2_
  - [x] 7.3 Create `src/db/remote-database-adapter.ts` implementing `DatabaseAdapter`
    - `initialize()` establishes gRPC channel to `serverUrl`
    - `close()` closes gRPC channel cleanly
    - `getGraphAdapter()` / `getVectorAdapter()` return remote adapters
    - `getEmbeddingAdapter()` returns local embedding adapter (embeddings stay client-side)
    - Transparent reconnection on transient gRPC errors
    - Include configured prefix in every gRPC request
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 8.4_

- [x] 8. AutostartManager with cross-process lock and discovery (Phase 5)
  _Skills: `typescript-expert`, `nodejs-best-practices`, `error-handling-patterns`
  - [x] 8.1 Create `src/db/autostart.ts` implementing `AutostartManager`
    - `ensureServer(config)`: health check → lock → re-check → spawn detached → poll readiness → write discovery
    - Use `proper-lockfile` for cross-process lock at `config.lockPath`
    - Always release lock in `finally` block, even on error
    - Write `DiscoveryFile` JSON on successful autostart
    - Treat stale discovery file as ignorable (verify via Health.Check)
    - Fail with `ServerUnavailableError` when autostart disabled and server unreachable
    - Fail with `ServerStartupTimeoutError` when readiness not achieved within timeout
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

- [x] 9. Checkpoint — Verify client adapters and autostart
  - Ensure `RemoteDatabaseAdapter` connects to a running server and proxies operations. Verify autostart spawns the server when needed. Ask the user if questions arise.

- [x] 10. Adapter factory extension and MetricsCollector (Phase 6)
  _Skills: `typescript-expert`, `architecture`, `clean-code`
  - [x] 10.1 Extend `createDatabaseAdapter` in `src/db/database-adapter.ts`
    - Check `config.ladybugdb.runtimeMode`: if `"client"`, build `LadybugClientConfig`, call `ensureServerAndConnect`, return `RemoteDatabaseAdapter`
    - If `"server"` (default), create `LadybugDatabaseAdapter` as today
    - Validate all config fields before creating adapter
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 1.1_
  - [x] 10.2 Create `src/db-server/metrics.ts` implementing `MetricsCollector`
    - `recordRequest(endpoint, durationMs, status)` tracks per-endpoint count, error count, latency
    - `getMetrics()` returns `ServerMetrics` with uptime, dbOpen, inFlight, queued, p50/p99 latency
    - _Requirements: 5.1_
  - [x] 10.3 Add structured logging for startup, shutdown, db open/close, queue saturation, request timeouts, request failures
    - Redact sensitive values (auth tokens, passwords) in all log output
    - _Requirements: 5.2, 5.6_
  - [x] 10.4 Add auth token validation middleware to gRPC server
    - When `LADYBUG_SERVER_AUTH_TOKEN` is non-empty, reject requests without matching bearer token
    - Enforce request size limits at gRPC layer
    - _Requirements: 5.4, 5.5_

- [x] 11. Checkpoint — Verify adapter factory and observability
  - Ensure `createDatabaseAdapter` returns the correct adapter type based on `runtimeMode`. Verify metrics collection and auth token enforcement. Ask the user if questions arise.
