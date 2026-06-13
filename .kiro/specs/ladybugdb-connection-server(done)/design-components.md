Part of the [LadybugDB Connection Server Design](./design.md).

# Components & Interfaces

## Component 1: EmbeddedDatabaseRuntime

**Purpose**: Wraps `createLadybugConnection()` lifecycle. Owns the single LadybugDB `Database` instance, initializes schema on startup, handles WAL flush on shutdown.

```typescript
interface EmbeddedDatabaseRuntime {
  open(dbPath: string, prefix: string): Promise<void>;
  getConnection(): Connection;
  getDatabase(): Database;
  close(): Promise<void>;
  isHealthy(): boolean;
}
```

**Responsibilities**: Single owner of the LadybugDB file lock, schema initialization, WAL flush and clean shutdown, health status reporting.

## Component 2: OperationRouter

**Purpose**: Maps gRPC requests to graph/vector operations. Validates payloads and applies prefix context.

```typescript
interface OperationRouter {
  routeGraphOp(op: GraphOperation, prefix: string): Promise<GraphResult>;
  routeVectorOp(op: VectorOperation, prefix: string): Promise<VectorResult>;
}
```

**Responsibilities**: Payload validation, prefix application, delegation to graph/vector adapters, error translation to gRPC status codes.

## Component 3: RequestScheduler

**Purpose**: Enforces concurrency limits, priority queuing, and timeout management. Prevents indexing writes from starving interactive reads.

```typescript
type RequestPriority = "admin" | "interactive_read" | "background_write";

interface ScheduledRequest<T> {
  readonly id: string;
  readonly priority: RequestPriority;
  readonly timeoutMs: number;
  readonly execute: () => Promise<T>;
}

interface RequestScheduler {
  enqueue<T>(request: ScheduledRequest<T>): Promise<T>;
  drain(): Promise<void>;
  stats(): SchedulerStats;
}

interface SchedulerStats {
  readonly inFlight: number;
  readonly queued: number;
  readonly totalProcessed: number;
  readonly totalTimedOut: number;
  readonly totalRejected: number;
}
```

**Responsibilities**: Bounded priority queue (max `LADYBUG_SERVER_MAX_QUEUE`), concurrency limiter (max `LADYBUG_SERVER_MAX_CONCURRENCY`), per-request timeout, priority ordering (admin > interactive_read > background_write), graceful drain.

## Component 4: MetricsCollector

**Purpose**: Collects and exposes server health and performance metrics.

```typescript
interface MetricsCollector {
  recordRequest(endpoint: string, durationMs: number, status: "ok" | "error" | "timeout"): void;
  getMetrics(): ServerMetrics;
}

interface ServerMetrics {
  readonly uptimeMs: number;
  readonly dbOpen: boolean;
  readonly inFlightRequests: number;
  readonly queuedRequests: number;
  readonly requestCounts: Record<string, number>;
  readonly errorCounts: Record<string, number>;
  readonly latencyP50Ms: Record<string, number>;
  readonly latencyP99Ms: Record<string, number>;
}
```

## Component 5: RemoteDatabaseAdapter

**Purpose**: Implements `DatabaseAdapter` by proxying graph/vector operations to the connection server over gRPC. Drop-in replacement for `LadybugDatabaseAdapter`.

```typescript
class RemoteDatabaseAdapter implements DatabaseAdapter {
  constructor(config: LadybugClientConfig);
  initialize(): Promise<void>;
  close(): Promise<void>;
  getGraphAdapter(): GraphAdapter;
  getVectorAdapter(): VectorAdapter;
  getEmbeddingAdapter(): EmbeddingAdapter;
}
```

**Responsibilities**: gRPC channel management, protobuf serialization/deserialization, deadline propagation, transparent reconnection on transient failures.

## Component 6: AutostartManager

**Purpose**: Client-side logic to ensure the connection server is running. Coordinates via cross-process lock and discovery file.

```typescript
interface AutostartManager {
  ensureServer(config: LadybugClientConfig): Promise<void>;
  readDiscovery(discoveryPath: string): Promise<DiscoveryInfo | null>;
}

interface DiscoveryInfo {
  readonly pid: number;
  readonly startedAt: string;
  readonly prefix: string;
  readonly dbPath: string;
  readonly url: string;
}
```

**Responsibilities**: Health check with short deadline, cross-process lock via `proper-lockfile`, detached server spawn, readiness polling with configurable timeout, discovery file write/read.

gRPC service type definitions are in [Data Models](./design-data-models.md).
