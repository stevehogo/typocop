Part of the [Requirements Document](./requirements.md).

# Client & Operations Requirements

### Requirement 6: RemoteDatabaseAdapter

**User Story:** As a client process (MCP, CLI, query server), I want a drop-in DatabaseAdapter that proxies operations over gRPC, so that I can access the database without code changes.

#### Acceptance Criteria

1. THE RemoteDatabaseAdapter SHALL implement the `DatabaseAdapter` interface (`initialize`, `close`, `getGraphAdapter`, `getVectorAdapter`, `getEmbeddingAdapter`)
2. FOR ALL operations in `GraphAdapter` and `VectorAdapter`, the RemoteDatabaseAdapter SHALL produce the same result as `LadybugDatabaseAdapter` given the same database state
3. WHEN `initialize()` is called, THE RemoteDatabaseAdapter SHALL establish a gRPC channel to the configured `serverUrl`
4. WHEN `close()` is called, THE RemoteDatabaseAdapter SHALL close the gRPC channel cleanly
5. WHEN a transient gRPC error occurs, THEN THE RemoteDatabaseAdapter SHALL attempt transparent reconnection before surfacing the error
6. THE RemoteDatabaseAdapter SHALL propagate client-side deadlines to the server via gRPC metadata

### Requirement 7: AutostartManager

**User Story:** As a developer, I want the connection server to start automatically when needed, so that I do not have to manage it manually.

#### Acceptance Criteria

1. WHEN `Health.Check` is unreachable and `LADYBUG_SERVER_AUTOSTART` is `true`, THE AutostartManager SHALL acquire the cross-process lock, spawn the server, and poll for readiness
2. WHEN the cross-process lock is already held, THE AutostartManager SHALL wait for the lock holder to complete before re-checking health
3. WHEN readiness is confirmed after autostart, THE AutostartManager SHALL write the Discovery_File with pid, startedAt, prefix, dbPath, and url
4. WHEN readiness is not achieved within `LADYBUG_SERVER_STARTUP_TIMEOUT_MS`, THEN THE AutostartManager SHALL release the lock and surface a `ServerStartupTimeoutError`
5. THE AutostartManager SHALL always release the cross-process lock, even when an error occurs during autostart
6. WHEN a Discovery_File exists but the server is unreachable, THE AutostartManager SHALL treat the file as stale and proceed with autostart
7. WHEN `Health.Check` is unreachable and `LADYBUG_SERVER_AUTOSTART` is `false`, THEN THE AutostartManager SHALL fail with a `ServerUnavailableError` including the target URL

### Requirement 8: Multi-tenancy and Prefix Isolation

**User Story:** As a multi-tenant operator, I want each TYPOCOP_PREFIX to have isolated database access, so that tenants cannot read or write each other's data.

#### Acceptance Criteria

1. THE Connection_Server SHALL scope all graph and vector operations to the caller's `TYPOCOP_PREFIX`
2. THE Connection_Server SHALL use prefix-scoped defaults for `LADYBUGDB_PATH`, lock path, and discovery path
3. WHEN a client request carries a prefix that differs from the server's configured prefix, THEN THE OperationRouter SHALL reject the request with an `INVALID_ARGUMENT` status
4. THE RemoteDatabaseAdapter SHALL include the configured prefix in every gRPC request

### Requirement 9: Migration and Adapter Factory

**User Story:** As a team, I want a phased migration path from embedded to client mode, so that we can validate correctness before cutting over.

#### Acceptance Criteria

1. THE Adapter_Factory SHALL support both `"server"` and `"client"` runtime modes without changes to callers
2. WHEN `runtimeMode` is `"client"`, THE Adapter_Factory SHALL call `ensureServerAndConnect` to obtain a `RemoteDatabaseAdapter`
3. WHEN `runtimeMode` is `"server"`, THE Adapter_Factory SHALL create a `LadybugDatabaseAdapter` using the existing embedded path
4. THE Adapter_Factory SHALL validate all configuration fields before creating an adapter

### Requirement 10: Serialization and Data Integrity

**User Story:** As a developer, I want gRPC serialization to preserve data fidelity, so that remote operations return identical results to local operations.

#### Acceptance Criteria

1. FOR ALL valid `GraphNode` objects, serializing to protobuf and deserializing back SHALL produce an equivalent object
2. FOR ALL valid `SearchResult` objects, serializing to protobuf and deserializing back SHALL produce an equivalent object
3. WHEN the server returns an error, THE gRPC transport SHALL map the error to the correct gRPC status code and include a structured `ErrorDetail` with code, message, and retryable flag
