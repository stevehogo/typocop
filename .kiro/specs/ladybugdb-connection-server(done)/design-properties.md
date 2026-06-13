Part of the [LadybugDB Connection Server Design](./design.md).

# Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Adapter factory mode selection

*For any* valid configuration, `createDatabaseAdapter` SHALL return a `LadybugDatabaseAdapter` when `runtimeMode === "server"` and a `RemoteDatabaseAdapter` when `runtimeMode === "client"`.

**Validates: Requirements 1.1, 9.1, 9.2, 9.3**

### Property 2: Configuration validation rejects invalid inputs

*For any* configuration where `serverUrl` is not a valid `grpc://` URL (in client mode), or `port` is outside 1–65535, or `maxConcurrency < 1`, or `maxQueue < 1`, the Configuration_Loader SHALL reject with a descriptive error.

**Validates: Requirements 1.3, 1.4, 9.4**

### Property 3: Configuration defaults applied for missing env vars

*For any* subset of environment variables, all missing variables SHALL resolve to their documented default values.

**Validates: Requirement 1.2**

### Property 4: Concurrency bound invariant

*For any* sequence of enqueued requests, `RequestScheduler.inFlight` SHALL never exceed `maxConcurrency`.

**Validates: Requirement 4.1**

### Property 5: Queue bound invariant

*For any* sequence of enqueued requests, `RequestScheduler.queue.length` SHALL never exceed `maxQueue`, and attempts to exceed it SHALL be rejected.

**Validates: Requirements 4.2, 4.3**

### Property 6: Priority ordering

*For any* batch of mixed-priority requests enqueued while the scheduler is at capacity, higher-priority requests (admin > interactive_read > background_write) SHALL execute before lower-priority ones.

**Validates: Requirement 4.4**

### Property 7: Timeout guarantee

*For any* request with a `timeoutMs`, the request SHALL complete or be rejected within `timeoutMs` plus scheduling overhead.

**Validates: Requirement 4.5**

### Property 8: Prefix isolation

*For any* gRPC request, the OperationRouter SHALL scope all database operations to the caller's prefix, and the RemoteDatabaseAdapter SHALL include the configured prefix in every outgoing request.

**Validates: Requirements 3.5, 8.1, 8.4**

### Property 9: Lock release guarantee

*For any* autostart attempt, including those that fail with errors, the cross-process lock SHALL be released.

**Validates: Requirement 7.5**

### Property 10: GraphNode serialization round-trip

*For any* valid `GraphNode` object, serializing to protobuf and deserializing back SHALL produce an equivalent object.

**Validates: Requirement 10.1**

### Property 11: SearchResult serialization round-trip

*For any* valid `SearchResult` object, serializing to protobuf and deserializing back SHALL produce an equivalent object.

**Validates: Requirement 10.2**

### Property 12: Error-to-gRPC-status mapping

*For any* server-side error, the gRPC transport SHALL map it to the correct gRPC status code and include a structured `ErrorDetail` with code, message, and retryable flag.

**Validates: Requirement 10.3**

### Property 13: Adapter interface equivalence

*For all* operations in `GraphAdapter` and `VectorAdapter`, `RemoteDatabaseAdapter.op(args)` SHALL produce the same result as `LadybugDatabaseAdapter.op(args)` given the same database state.

**Validates: Requirement 6.2**

### Property 14: Prefix-scoped path defaults

*For any* `TYPOCOP_PREFIX` value, the derived `LADYBUGDB_PATH`, lock path, and discovery path SHALL contain the prefix in their resolved paths.

**Validates: Requirement 8.2**
