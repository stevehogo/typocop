Part of the [LadybugDB Connection Server Design](./design.md).

# Error Handling, Testing & Operational Notes

## Correctness Properties

See [Correctness Properties](./design-properties.md) — 14 properties with requirement traceability.

## Error Handling

### Server Unavailable (Client Mode)
**Condition**: `Health.Check` unreachable. **Response**: Autostart if enabled, else `ServerUnavailableError`. **Recovery**: Retry after autostart.

### Queue Full
**Condition**: Queue at `maxQueue`. **Response**: gRPC `RESOURCE_EXHAUSTED`, `QueueFullError`. **Recovery**: Client retries with backoff.

### Request Timeout
**Condition**: Request exceeds `timeoutMs`. **Response**: gRPC `DEADLINE_EXCEEDED`. **Recovery**: Client retries.

### Database Open Failure
**Condition**: `open()` fails (corrupt, permissions, lock held). **Response**: Server exits non-zero. **Recovery**: Operator investigates.

### Stale Discovery File
**Condition**: File exists but server unreachable. **Response**: Ignore, proceed with autostart. **Recovery**: Fresh file on next start.

### Concurrent Autostart Race
**Condition**: Multiple clients detect server down. **Response**: First acquires lock and spawns; others wait. **Recovery**: All connect to single server.

## Testing Strategy

### Unit Tests
- `RequestScheduler`: concurrency limits, priority ordering, timeout, drain
- `OperationRouter`: validation, prefix application, error translation
- `RemoteGraphAdapter`/`RemoteVectorAdapter`: serialization roundtrip
- `AutostartManager`: lock, discovery, health check logic
- Adapter factory: mode selection
- Config validation: env var parsing, defaults, constraints

### Property-Based Tests (fast-check)
- Scheduler never exceeds concurrency bound (∀ request sequences)
- Queue never exceeds max size (∀ enqueue patterns)
- Priority ordering holds (∀ mixed-priority batches)
- Serialization roundtrip preserves data (∀ GraphNode, SearchResult)

### Integration Tests
- One server with concurrent MCP/query/CLI clients
- Graceful shutdown with in-flight requests
- Indexing writes + concurrent query reads (priority validation)
- Server restart and client reconnection
- Autostart with multiple simultaneous clients
- Response equivalence: `LadybugDatabaseAdapter` vs `RemoteDatabaseAdapter`

### Regression Tests
- No WAL corruption after repeated mixed-process runs
- No file lock contention in client mode
- Prefix isolation: two prefixes, two servers, no cross-contamination

## Example Usage

```typescript
// Server mode (standalone process)
import { startConnectionServer } from "./db-server/server.js";
await startConnectionServer({
  runtimeMode: "server", prefix: "tpc_",
  dbPath: "~/.typocop/tpc_/db.ladybug",
  host: "127.0.0.1", port: 7617, authToken: "",
  maxConcurrency: 4, maxQueue: 256, idleTtlMs: 0,
});

// Client mode (MCP/CLI/Query — transparent proxy)
const adapter = await createDatabaseAdapter(config);
const symbols = await adapter.getGraphAdapter().queryNodes("Symbol", { kind: "function" });
await adapter.close();
```

## Performance Considerations
- gRPC adds ~1-2ms per local hop. Acceptable for correctness gains.
- HTTP/2 multiplexing: one TCP connection per client suffices.
- Default concurrency of 4 matches typical LadybugDB write throughput.
- Protobuf serialization faster than JSON for structured payloads.

## Security Considerations
- Binds to `127.0.0.1` by default — not network-exposed.
- Optional bearer token (`LADYBUG_SERVER_AUTH_TOKEN`).
- Request size limits at gRPC layer.
- Input validation for all payloads. Sensitive values redacted in logs.

## Dependencies
- `@grpc/grpc-js` — gRPC server/client for Node.js
- `@grpc/proto-loader` — Dynamic protobuf loading
- `proper-lockfile` — Cross-process file locking (existing dep)
- `@ladybugdb/core` — Embedded database engine (existing dep)
- `uuid` — Request ID generation
- Protobuf toolchain — `protoc` + TypeScript plugin
