Part of the [Requirements Document](./requirements.md).

# Server & Runtime Requirements

### Requirement 1: Configuration and Runtime Mode Selection

**User Story:** As a developer, I want to configure Typocop processes as either server or client mode, so that exactly one process owns the database while others connect remotely.

#### Acceptance Criteria

1. THE Adapter_Factory SHALL select `LadybugDatabaseAdapter` WHEN `runtimeMode` is `"server"` and `RemoteDatabaseAdapter` WHEN `runtimeMode` is `"client"`
2. THE Configuration_Loader SHALL read all server/client settings from environment variables with documented defaults
3. WHEN `runtimeMode` is `"client"` and `serverUrl` is not a valid `grpc://` URL, THEN THE Configuration_Loader SHALL reject the configuration with a descriptive error
4. WHEN `port` is outside 1–65535 or `maxConcurrency` is less than 1 or `maxQueue` is less than 1, THEN THE Configuration_Loader SHALL reject the configuration with a descriptive error

### Requirement 2: EmbeddedDatabaseRuntime

**User Story:** As the connection server, I want to own the single LadybugDB instance for a dbPath, so that no other process can corrupt the WAL or contend for the file lock.

#### Acceptance Criteria

1. WHEN `open(dbPath, prefix)` is called, THE EmbeddedDatabaseRuntime SHALL acquire the LadybugDB file lock and initialize the database schema
2. WHILE the EmbeddedDatabaseRuntime is open, THE EmbeddedDatabaseRuntime SHALL be the sole holder of the file lock for that dbPath
3. WHEN `close()` is called, THE EmbeddedDatabaseRuntime SHALL flush the WAL and release the file lock
4. WHEN `open()` fails due to corruption, permissions, or a held lock, THEN THE Connection_Server SHALL exit with a non-zero status code and a descriptive error message
5. THE EmbeddedDatabaseRuntime SHALL report `isHealthy() === true` only when the database is open and operational

### Requirement 3: gRPC Server with Health, Admin, Graph, and Vector Services

**User Story:** As a client process, I want to call graph and vector operations over gRPC, so that I can access the database without owning it directly.

#### Acceptance Criteria

1. THE Connection_Server SHALL expose a `Health.Check` RPC that returns `SERVING` when the database is open and the RequestScheduler is accepting requests
2. THE Connection_Server SHALL expose an `Admin.GetMetrics` RPC returning queue depth, in-flight requests, uptime, and per-endpoint latency
3. THE Connection_Server SHALL expose Graph RPCs: `QueryNodes`, `QueryRelationships`, `RunCypher`, `RunCypherWrite`, `CreateNode`, `CreateRelationship`, `DeleteNodesByLabel`, `DeleteRelationshipsByType`
4. THE Connection_Server SHALL expose Vector RPCs: `CreateTables`, `IndexSymbol`, `SemanticSearch`, `DeleteAll`
5. WHEN a gRPC request carries a `prefix` field, THE OperationRouter SHALL scope all database operations to that prefix
6. WHEN a gRPC request payload fails validation, THEN THE OperationRouter SHALL return an `INVALID_ARGUMENT` gRPC status with a descriptive error
7. WHEN `SIGTERM` or `Admin.Shutdown` is received, THE Connection_Server SHALL stop accepting new connections, drain in-flight requests, flush the WAL, remove the Discovery_File, and exit cleanly

### Requirement 4: RequestScheduler

**User Story:** As a server operator, I want concurrency limits and priority queuing, so that indexing writes do not starve interactive reads.

#### Acceptance Criteria

1. WHILE the RequestScheduler is operational, THE RequestScheduler SHALL maintain `inFlight <= maxConcurrency` at all times
2. WHILE the RequestScheduler is operational, THE RequestScheduler SHALL maintain `queue.length <= maxQueue` at all times
3. WHEN the queue is full, THEN THE RequestScheduler SHALL reject new requests with a `RESOURCE_EXHAUSTED` gRPC status
4. THE RequestScheduler SHALL execute higher-priority requests before lower-priority ones (admin > interactive_read > background_write)
5. WHEN a request exceeds its `timeoutMs`, THEN THE RequestScheduler SHALL reject the request with a `DEADLINE_EXCEEDED` gRPC status
6. WHEN `drain()` is called, THE RequestScheduler SHALL reject new requests, wait for in-flight requests to complete, and signal completion

### Requirement 5: Observability and Security

**User Story:** As a server operator, I want metrics, structured logging, and basic security controls, so that I can monitor and protect the connection server.

#### Acceptance Criteria

1. THE MetricsCollector SHALL record per-endpoint request count, error count, and latency percentiles (p50, p99)
2. THE Connection_Server SHALL log startup, shutdown, database open/close, queue saturation, request timeouts, and request failures
3. THE Connection_Server SHALL bind to `127.0.0.1` by default
4. WHEN `LADYBUG_SERVER_AUTH_TOKEN` is non-empty, THE Connection_Server SHALL reject requests that do not carry a matching bearer token
5. THE Connection_Server SHALL enforce request size limits at the gRPC layer
6. THE Connection_Server SHALL redact sensitive values in all log output
