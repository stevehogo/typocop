Part of the [LadybugDB Connection Server Design](./design.md).

# Data Models

## Configuration Types

```typescript
type LadybugRuntimeMode = "server" | "client";

interface LadybugServerConfig {
  readonly runtimeMode: LadybugRuntimeMode;
  readonly prefix: string;
  readonly dbPath: string;
  readonly host: string;
  readonly port: number;
  readonly authToken: string;
  readonly maxConcurrency: number;
  readonly maxQueue: number;
  readonly idleTtlMs: number;
}

interface LadybugClientConfig {
  readonly runtimeMode: "client";
  readonly prefix: string;
  readonly dbPath: string;
  readonly serverUrl: string;
  readonly authToken: string;
  readonly autostart: boolean;
  readonly startupTimeoutMs: number;
  readonly lockPath: string;
  readonly discoveryPath: string;
}
```

**Validation Rules**:
- `runtimeMode` must be `"server"` or `"client"`
- `port` must be 1–65535
- `maxConcurrency` >= 1, `maxQueue` >= 1
- `startupTimeoutMs` > 0, `idleTtlMs` >= 0 (0 = never idle-exit)
- `serverUrl` must be a valid `grpc://` URL when `runtimeMode === "client"`

## Extended FullConfig

```typescript
interface FullConfig {
  readonly prefix: string;
  readonly ollama: OllamaConfig;
  readonly embedding: EmbeddingConfig;
  readonly ladybugdb: LadybugDBConfig & {
    readonly runtimeMode: LadybugRuntimeMode;
    readonly serverUrl: string;
    readonly serverHost: string;
    readonly serverPort: number;
    readonly serverAuthToken: string;
    readonly serverMaxConcurrency: number;
    readonly serverMaxQueue: number;
    readonly serverAutostart: boolean;
    readonly serverStartupTimeoutMs: number;
    readonly serverLockPath: string;
    readonly serverDiscoveryPath: string;
    readonly serverIdleTtlMs: number;
  };
  readonly loadedAt: Date;
  readonly source: "environment" | "env-file" | "default";
}
```

## gRPC Request/Response Models

```typescript
interface RequestMetadata {
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly prefix: string;
}

interface ErrorDetail {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

interface DiscoveryFile {
  readonly pid: number;
  readonly startedAt: string;
  readonly prefix: string;
  readonly dbPath: string;
  readonly url: string;
}
```

## Environment Variable Defaults

| Variable | Default | Purpose |
|----------|---------|---------|
| `LADYBUG_RUNTIME_MODE` | `server` | Process mode (`server` or `client`) |
| `TYPOCOP_PREFIX` | `tpc_` | Tenant/schema prefix |
| `LADYBUGDB_PATH` | `~/.typocop/{prefix}/db.ladybug` | Database storage path |
| `LADYBUG_SERVER_URL` | `grpc://127.0.0.1:7617` | Client target URL |
| `LADYBUG_SERVER_HOST` | `127.0.0.1` | Server bind host |
| `LADYBUG_SERVER_PORT` | `7617` | Server bind port |
| `LADYBUG_SERVER_AUTH_TOKEN` | empty | Optional local auth token |
| `LADYBUG_SERVER_MAX_CONCURRENCY` | `4` | Max concurrent DB operations |
| `LADYBUG_SERVER_MAX_QUEUE` | `256` | Max queued requests |
| `LADYBUG_SERVER_AUTOSTART` | `false` | Client-side autostart |
| `LADYBUG_SERVER_STARTUP_TIMEOUT_MS` | `10000` | Max wait for readiness |
| `LADYBUG_SERVER_LOCK_PATH` | `~/.typocop/locks/{prefix}-ladybug-server.lock` | Cross-process lock |
| `LADYBUG_SERVER_DISCOVERY_PATH` | `~/.typocop/{prefix}/ladybug-server.json` | Discovery file |
| `LADYBUG_SERVER_IDLE_TTL_MS` | `0` | Idle shutdown (0 = never) |

## Error Types

| Error Class | Constructor Args | gRPC Status |
|-------------|-----------------|-------------|
| `ServerUnavailableError` | `serverUrl: string` | `UNAVAILABLE` |
| `ServerStartupTimeoutError` | `timeoutMs: number` | N/A (client-side) |
| `QueueFullError` | `maxQueue: number` | `RESOURCE_EXHAUSTED` |
| `RequestTimeoutError` | `requestId, timeoutMs` | `DEADLINE_EXCEEDED` |
| `ServerDrainingError` | (none) | `UNAVAILABLE` |

## Expected File Structure

- `src/db-server/` — `main.ts`, `server.ts`, `runtime.ts`, `router.ts`, `scheduler.ts`, `metrics.ts`, `discovery.ts`, `types.ts`
- `src/db-server/services/` — `health.ts`, `admin.ts`, `graph.ts`, `vector.ts`
- `src/db/` — `remote-database-adapter.ts`, `remote-graph-adapter.ts`, `remote-vector-adapter.ts`, `autostart.ts`
- `proto/` — `ladybug_connection.proto`
