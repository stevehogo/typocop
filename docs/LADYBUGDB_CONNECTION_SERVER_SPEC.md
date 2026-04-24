# LadybugDB Connection Server Spec

## Status
Proposed

## Summary

Typocop currently treats LadybugDB as an embedded, per-process resource. The CLI, MCP server, and query server each create their own `DatabaseAdapter`, which acquires a local LadybugDB connection and relies on careful shutdown to flush WAL state and release the file lock.

This works inside a single process, but it is a poor fit for a multi-process runtime. The current design still serializes access at the file-lock level and has already produced WAL corruption when a process exited without draining pools.

This spec proposes a standalone **LadybugDB Connection Server** that runs once, owns the only embedded LadybugDB instance for a `dbPath`, and exposes a local gRPC API. Other Typocop processes become thin clients.

## Current State

### Relevant code paths

- `src/db/database-adapter.ts`
  Creates a `LadybugDatabaseAdapter`, gets a pool from `getPool(dbPath)`, acquires a connection, then exposes graph/vector/embedding adapters over that connection.
- `src/db/connection-pool.ts`
  Implements an in-process pool over one shared LadybugDB `Database` instance.
- `src/db/connection.ts`
  Maintains a per-process singleton cache and an OS file lock for the database path.
- `src/mcp/server.ts`
  Creates one long-lived adapter and reuses it across MCP tool calls.
- `src/query/server.ts`
  Expects an already-initialized `DatabaseAdapter` to serve the query HTTP API.
- `src/cli/executor.ts`
  Creates an adapter for indexing/status operations, then closes it in `finally`.

### Observed problem

The existing pool solves only **in-process** reuse. It does not provide safe multi-process concurrency because:

- LadybugDB is embedded and guarded by a file lock.
- every process still attempts to open the database locally
- shutdown correctness depends on every process draining pools
- multiple long-lived processes compete for ownership of the same database file

The existing audit docs confirm this failure mode:

- `DATABASE_CONNECTION_AUDIT.md`
- `DATABASE_CORRUPTION_FIX.md`

## Goals

- Ensure exactly one process owns the LadybugDB database lock for a given `dbPath`.
- Allow MCP, CLI indexing, and query-serving workloads to operate concurrently through one shared DB owner.
- Remove WAL/file-lock corruption caused by multi-process embedded access.
- Preserve Typocop multi-tenancy semantics based on `TYPOCOP_PREFIX` and tenant-scoped storage paths.
- Reuse as much of the current query/indexing logic as possible.
- Support local deployment first, with a clear path to remote deployment later.
- Provide observability for queue depth, active requests, and DB health.

## Non-Goals

- Replacing Typocop’s `DatabaseAdapter` domain model.
- Introducing distributed clustering or multi-writer replication.
- Exposing LadybugDB directly to untrusted remote clients in the first version.
- Rewriting indexing/query logic around a new internal execution engine.

## Architecture

### Target topology

```text
┌─────────────────────────────────────────┐
│   LadybugDB Connection Server           │
│   (runs once, holds the Database lock)  │
│   - Manages single Database instance    │
│   - Exposes local gRPC API              │
└─────────────────────────────────────────┘
         ↑              ↑              ↑
         │              │              │
    ┌────┴──┐      ┌────┴──┐      ┌────┴──┐
    │ MCP   │      │ CLI   │      │Query  │
    │Server │      │Indexer│      │Server │
    └───────┘      └───────┘      └───────┘
```

### High-level design

1. Add a new standalone process, `ladybug-connection-server`.
2. That process alone calls the current LadybugDB connection/bootstrap code.
3. All other runtimes use a client-backed adapter instead of a local embedded adapter.
4. The server executes graph/vector operations on behalf of clients and returns typed results.
5. The in-process pool remains an internal server concern or is removed entirely if one connection is sufficient.

## Architecture Decision Record

### Context

Typocop now has multiple independent processes that may access the same embedded LadybugDB database:

- CLI indexing
- MCP server
- query server
- future worker-style processes

The current code assumes local ownership and careful shutdown. That is fragile once access is shared across process boundaries.

### Options considered

| Option | Pros | Cons | Complexity | When valid |
|--------|------|------|------------|-----------|
| Keep per-process embedded access | Minimal code change | Still file-lock serialized, still shutdown-fragile, no real multi-process support | Low | Single-process only |
| Standalone HTTP connection server | Simpler operationally, easy to inspect manually | Weaker contract, ad hoc payloads, poorer streaming support | Medium | Valid as a fallback/admin surface |
| Standalone gRPC connection server | Strong schema, streaming, good cross-language support | More tooling and build complexity | Medium-high | Recommended for the DB service boundary |
| Full external DB service | Solves ownership centrally | Larger migration, loses embedded simplicity | High | Only if embedded mode is abandoned |

### Decision

Build a standalone connection server with a **gRPC API in v1**. Keep HTTP limited to health/metrics or optional admin endpoints if needed.

### Rationale

1. The core problem is process ownership of an embedded file-backed database, not lack of an in-process pool.
2. Existing Typocop layers already depend on `DatabaseAdapter`, which makes a client-backed adapter a narrow migration seam.
3. gRPC gives the project an explicit, versionable contract for graph/vector operations instead of loosely shaped JSON payloads.
4. Unary RPCs work for the initial cut, while streaming remains available if result sizes grow.
5. The additional tooling cost is justified because this service boundary is central to the architecture.

### Trade-offs accepted

- We accept an extra local RPC hop on every DB operation.
- We accept protobuf/tool generation and a stricter evolution process for the service contract.
- We accept that some low-level adapter calls may need batching to avoid chatty traffic.
- We accept slightly more deployment complexity in exchange for correctness and a stronger interface boundary.

### Revisit triggers

- The service remains Node-only and the protobuf/tooling overhead outweighs the benefits.
- The API stabilizes around a very small surface where plain HTTP would be materially simpler.

## Component Design

### 1. Connection Server

Responsibilities:

- open and own the only LadybugDB `Database` for the configured `dbPath`
- initialize schema on startup
- execute graph/vector operations requested by clients
- serialize shutdown and WAL flush correctly
- expose health and metrics endpoints
- enforce local auth / client identity if enabled

Suggested entrypoint:

- `src/db-server/main.ts`
- `src/db-server/server.ts`

Suggested internal layers:

- `EmbeddedDatabaseRuntime`
  Wraps current `createLadybugConnection()` and lifecycle behavior.
- `OperationRouter`
  Maps RPC requests to graph/vector/embedding operations.
- `RequestScheduler`
  Applies concurrency limits, queueing, cancellation, and timeouts.
- `MetricsCollector`
  Publishes health and pool/runtime metrics.

### 2. Client-backed DatabaseAdapter

Add a new adapter implementation, for example:

- `RemoteDatabaseAdapter`

This adapter should implement the existing `DatabaseAdapter` interface and proxy calls to the connection server. That keeps these callers mostly unchanged:

- `src/mcp/server.ts`
- `src/query/server.ts`
- `src/cli/executor.ts`

Factory direction:

- keep `createDatabaseAdapter(config)`
- choose between `LadybugDatabaseAdapter` and `RemoteDatabaseAdapter` based on config

Example config shape:

```ts
interface LadybugRuntimeConfig {
  mode: "server" | "client";
  prefix: string;
  dbPath: string;
  serverUrl?: string;
  authToken?: string;
}
```

### 3. Transport

#### v1 choice: gRPC

Reasons:

- strongly typed service contract for graph/vector/database operations
- supports unary calls now and streaming later without changing transports
- better fit for internal service-to-service communication than open-ended JSON
- easier to keep client/server behavior aligned across MCP, CLI, and query runtimes

Binding:

- default to `127.0.0.1`
- use a dedicated port, e.g. `7617`
- optionally support Unix domain sockets later for lower overhead

Implementation note:

- Keep a minimal HTTP listener only for `/health` and `/metrics` if operationally useful.
- The database operation surface should be gRPC-first.

## API Surface

The API should expose **operations**, not raw arbitrary database access from day one. That keeps the boundary stable and lets the server enforce invariants.

### Protocol definition

Define the public service contract in protobuf, for example:

- `proto/ladybug_connection.proto`

Generate Node server/client types from that contract and treat the `.proto` file as the canonical boundary.

### Required services / RPCs

#### Health and admin

- `Health.Check`
  Returns liveness/readiness and DB-open state.
- `Admin.GetMetrics`
  Returns queue depth, in-flight requests, uptime, and request latency counters.
- `Admin.Shutdown`
  Optional local-admin RPC for controlled shutdown.

#### Graph service

- `Graph.QueryNodes`
- `Graph.QueryRelationships`
- `Graph.RunCypher`
- `Graph.RunCypherWrite`
- `Graph.CreateNode`
- `Graph.CreateRelationship`
- `Graph.DeleteNodesByLabel`
- `Graph.DeleteRelationshipsByType`

#### Vector service

- `Vector.CreateTables`
- `Vector.IndexSymbol`
- `Vector.SemanticSearch`
- `Vector.DeleteAll`

#### Embedding operations

Two valid choices:

1. Keep embeddings client-side.
   This is simpler if the embedding model is already local to the caller.
2. Centralize embeddings in the server.
   This is better if the goal is one consistent embedding runtime.

Recommendation:
Keep embedding generation **client-side in v1** and send vectors to the server. gRPC handles structured vector payloads cleanly while keeping the DB server focused on persistence and query execution.

## Request Model

### Common request envelope

```json
{
  "requestId": "uuid",
  "timeoutMs": 30000,
  "prefix": "tpc_",
  "payload": {}
}
```

In protobuf, carry these same semantics in explicit request fields or shared metadata messages rather than a generic JSON envelope.

### Common response envelope

```json
{
  "requestId": "uuid",
  "ok": true,
  "data": {},
  "error": null
}
```

In practice for gRPC:

- use standard gRPC status codes where possible
- return structured error details for retryability and domain-specific metadata
- propagate deadlines from the client into server execution

Error shape:

```json
{
  "requestId": "uuid",
  "ok": false,
  "error": {
    "code": "QUERY_TIMEOUT",
    "message": "Query timeout",
    "retryable": true
  }
}
```

## Concurrency Model

The server must separate:

- **client concurrency**
- **database execution concurrency**

Recommended v1 behavior:

- accept many client connections
- apply a bounded in-memory request queue
- execute DB operations under a configurable concurrency limit
- default to a conservative limit until LadybugDB concurrent behavior is benchmarked

Notes:

- Reads and writes may eventually need different queues.
- Indexing writes can starve interactive MCP/query traffic unless priority is explicit.

Recommended priorities:

1. health/admin
2. interactive reads from MCP/query server
3. background indexing writes

## Cancellation and Timeouts

Requirements:

- client request timeout must propagate to the server
- queued requests that time out before execution must be dropped
- shutdown must reject new requests and drain in-flight requests
- gRPC deadlines must map directly onto server-side cancellation

Expose:

- server-level default timeout
- per-request timeout
- max queue length

## Configuration

Add configuration for both server and client modes.

Every configuration item must have a defined default value so startup behavior is deterministic.

Suggested environment variables:

```bash
LADYBUG_RUNTIME_MODE=server
TYPOCOP_PREFIX=tpc_
LADYBUGDB_PATH=~/.typocop/{prefix}/db.ladybug
LADYBUG_SERVER_URL=grpc://127.0.0.1:7617
LADYBUG_SERVER_HOST=127.0.0.1
LADYBUG_SERVER_PORT=7617
LADYBUG_SERVER_AUTH_TOKEN=
LADYBUG_SERVER_MAX_CONCURRENCY=4
LADYBUG_SERVER_MAX_QUEUE=256

# On-demand autostart (client-side)
LADYBUG_SERVER_AUTOSTART=false
LADYBUG_SERVER_STARTUP_TIMEOUT_MS=10000
LADYBUG_SERVER_LOCK_PATH=~/.typocop/locks/{prefix}-ladybug-server.lock
LADYBUG_SERVER_DISCOVERY_PATH=~/.typocop/{prefix}/ladybug-server.json
LADYBUG_SERVER_IDLE_TTL_MS=0
```

Default values:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LADYBUG_RUNTIME_MODE` | `server` | Process mode. The standalone DB process uses `server`; application processes that connect to it must override to `client`. |
| `TYPOCOP_PREFIX` | `tpc_` | Tenant/schema prefix used to isolate labels, relationship types, and tenant-specific storage defaults. |
| `LADYBUGDB_PATH` | `~/.typocop/{prefix}/db.ladybug` | LadybugDB storage path owned by the connection server; `{prefix}` resolves from `TYPOCOP_PREFIX`. |
| `LADYBUG_SERVER_URL` | `grpc://127.0.0.1:7617` | Client target URL for the gRPC server. |
| `LADYBUG_SERVER_HOST` | `127.0.0.1` | Server bind host. |
| `LADYBUG_SERVER_PORT` | `7617` | Server bind port. |
| `LADYBUG_SERVER_AUTH_TOKEN` | empty | Optional local auth token; disabled when empty. |
| `LADYBUG_SERVER_MAX_CONCURRENCY` | `4` | Max concurrent DB operations executed by the server. |
| `LADYBUG_SERVER_MAX_QUEUE` | `256` | Max queued requests before the server rejects new work. |
| `LADYBUG_SERVER_AUTOSTART` | `false` | Allows a `client` process to start the server if it is unavailable. |
| `LADYBUG_SERVER_STARTUP_TIMEOUT_MS` | `10000` | Max wait for readiness after autostart spawn. |
| `LADYBUG_SERVER_LOCK_PATH` | `~/.typocop/locks/{prefix}-ladybug-server.lock` | Cross-process lock path for autostart coordination; `{prefix}` resolves from `TYPOCOP_PREFIX`. |
| `LADYBUG_SERVER_DISCOVERY_PATH` | `~/.typocop/{prefix}/ladybug-server.json` | Discovery file with PID and effective server URL; `{prefix}` resolves from `TYPOCOP_PREFIX`. |
| `LADYBUG_SERVER_IDLE_TTL_MS` | `0` | Idle shutdown timeout; `0` means never exit for idleness. |

Behavior:

- `server`
  Start the standalone DB-owning process.
- `client`
  Connect to the standalone server and proxy all DB operations.

Implementation note:

- The current embedded adapter remains useful during migration and test transition, but it is not part of the target runtime model for production usage.
- The connection server must load and honor `TYPOCOP_PREFIX` exactly as current Typocop commands do today.

## Multi-tenancy

Typocop already supports multi-tenancy through `TYPOCOP_PREFIX`. The connection server architecture must preserve that behavior.

Required behavior:

- Every client request must carry the effective prefix, or the client and server must share the same validated prefix configuration.
- The server must execute graph and vector operations within the caller's tenant context.
- Prefix stripping in MCP and query responses must continue to behave exactly as it does today.

Tenant isolation model:

- Primary isolation mechanism: `TYPOCOP_PREFIX`
  - isolates labels, relationship types, and other prefixed database objects
- Default storage isolation: `LADYBUGDB_PATH=~/.typocop/{prefix}/db.ladybug`
  - gives each tenant its own database file by default
- Optional advanced mode: multiple prefixes in one shared database file
  - allowed only if Typocop explicitly chooses a shared `LADYBUGDB_PATH`
  - tenant isolation still depends on prefix correctness for all graph/vector operations

Operational rule:

- The connection server process and all clients that connect to it must agree on the same tenant identity for a given server instance.
- In v1, the simplest supported model is one server instance per `TYPOCOP_PREFIX` because the default `LADYBUGDB_PATH`, lock path, and discovery path are all prefix-scoped.

## On-demand Autostart

Goal: allow MCP, `typocop parse`, and the query server to start the connection server only when needed, without creating duplicate servers when multiple processes start simultaneously.

### Overview

Autostart is a **client-side** behavior:

- a client tries to connect to the gRPC server
- if it is not reachable and `LADYBUG_SERVER_AUTOSTART=true`, the client starts it
- other clients starting at the same time wait for the first client to finish

This preserves “runs once” semantics while keeping the operational experience lightweight.

### Coverage

On-demand autostart must cover every current Typocop code path that reads from or writes to LadybugDB through a `DatabaseAdapter`.

Current DB-touching entrypoints:

- `src/mcp/server.ts`
  Long-lived MCP process that reads graph/vector data through tool handlers.
- `src/cli/executor.ts`
  CLI indexing, refresh, and status flows that write and read database state.
- `src/query/server.ts`
  Query HTTP API that reads graph/vector data through query execution.

Required rule:

- All application-side database access must flow through `createDatabaseAdapter(config)`.
- No command, helper, or server outside the connection server may instantiate embedded LadybugDB directly.
- Any new background worker, maintenance command, or migration utility that needs DB access must also use the same adapter factory so autostart, discovery, auth, and readiness behavior stay consistent.

Non-coverage:

- Commands that do not create a `DatabaseAdapter` and do not access LadybugDB must not trigger autostart.

### Lock mechanism (required)

To prevent two processes from starting two servers at the same time, clients must coordinate with a cross-process lock.

Recommended implementation approach:

- Use `proper-lockfile` (already in dependencies) to lock `LADYBUG_SERVER_LOCK_PATH`
- Lock file path default: `~/.typocop/locks/{prefix}-ladybug-server.lock`

Notes:

- This lock is separate from the LadybugDB database file lock. The database file lock remains owned by the server process only.
- The lock should be held only for the autostart critical section (re-check, spawn, wait for readiness, write discovery).

### Discovery mechanism (recommended)

Use a discovery file so clients can:

- determine whether a server is expected to be running
- learn the effective bind address/port (especially if dynamic ports are used later)
- support debug introspection (PID, start time)

Discovery file path default: `~/.typocop/{prefix}/ladybug-server.json`

Recommended contents:

```json
{
  "pid": 12345,
  "startedAt": "2026-04-23T00:00:00.000Z",
  "prefix": "tpc_",
  "dbPath": "/path/to/db",
  "url": "grpc://127.0.0.1:7617"
}
```

Guidance:

- Keep the port fixed in v1 if possible; the discovery file is still useful for PID/introspection.
- If the discovery file exists but the server is not reachable, treat it as stale and overwrite it on next successful start.

### Client algorithm

Used by any caller that needs a `DatabaseAdapter` (MCP, CLI, query server) in `client` mode.

1. Read config (`LADYBUG_SERVER_URL`, `LADYBUG_SERVER_AUTOSTART`, timeouts, auth).
2. Attempt to connect and call `Health.Check` with a short deadline.
3. If healthy: continue (create `RemoteDatabaseAdapter`).
4. If not healthy and `LADYBUG_SERVER_AUTOSTART` is false: fail with a “server unavailable” error that includes the target URL.
5. Acquire the autostart lock at `LADYBUG_SERVER_LOCK_PATH`.
6. Re-check health again (another process may have started it).
7. If still unhealthy:
   - Spawn the server process detached.
   - Wait for readiness by polling `Health.Check` until `LADYBUG_SERVER_STARTUP_TIMEOUT_MS` expires.
   - On success, write/overwrite the discovery file at `LADYBUG_SERVER_DISCOVERY_PATH`.
8. Release the autostart lock.
9. Create and return `RemoteDatabaseAdapter`.

### Server lifetime policy

Autostart needs a clear policy for when the server exits:

- Recommended v1 default: keep running until explicitly stopped.
  - `LADYBUG_SERVER_IDLE_TTL_MS=0` means “never exit due to idleness”.
- Optional: idle shutdown.
  - If `LADYBUG_SERVER_IDLE_TTL_MS > 0`, the server may exit after no requests for that duration.
  - Clients must be prepared to reconnect and autostart again.

### Failure modes and mitigations

- Startup succeeds but readiness never flips:
  - client times out (`LADYBUG_SERVER_STARTUP_TIMEOUT_MS`) and surfaces a clear error with server logs hint (if available).
- Stale discovery file:
  - client verifies by `Health.Check`; if unreachable, ignores stale file and autostarts.
- Multiple tenants / dbPaths:
  - lock and discovery must be keyed by tenant identity and effective `dbPath`.
  - the default prefix-scoped paths already satisfy this for one server per prefix.
  - if Typocop later supports arbitrary shared DB paths across multiple prefixes, use a stable hash of `prefix + dbPath` for lock/discovery naming.

## Security

The first version is intended for local trusted use, but it still needs basic controls.

Requirements:

- bind to loopback by default
- optional bearer token or mTLS between clients and server
- request size limits
- input validation for all operation payloads
- redact sensitive values in logs

Non-goal for v1:

- internet-exposed multi-tenant service

## Observability

Minimum metrics:

- server uptime
- DB open state
- in-flight requests
- queued requests
- per-endpoint latency
- timeout count
- error count by code
- indexing write duration

Minimum logs:

- startup/shutdown
- database open/close
- queue saturation
- request timeout
- request failure with operation name

## Migration Plan

### Phase 0: Prep

- Add runtime mode config.
- Introduce `RemoteDatabaseAdapter`.
- Keep the current embedded adapter only as a migration reference while server/client mode is being rolled out.

### Phase 1: Server skeleton

- Add standalone connection server process.
- Define the `.proto` contract and generate server/client stubs.
- Implement health/admin RPCs and a narrow subset of graph operations.
- Add integration tests with one server and one client.

### Phase 2: Read path migration

- Migrate MCP server and query server to client mode.
- Keep CLI indexing on the existing path only until client mode is ready.
- Validate correctness and latency for read-heavy workflows.

### Phase 3: Write path migration

- Move CLI indexing to client mode.
- Add request prioritization so indexing does not starve interactive reads.
- Remove process-local shutdown coupling from callers.

### Phase 4: Default cutover

- Make `client` the required runtime for MCP/query/CLI database access.
- Treat the old embedded path as deprecated and remove it once rollout is complete.

## Code Impact

### Expected new files

- `src/db-server/main.ts`
- `src/db-server/server.ts`
- `src/db-server/services/*.ts`
- `src/db/remote-database-adapter.ts`
- `src/db/remote-graph-adapter.ts`
- `src/db/remote-vector-adapter.ts`
- `src/db-server/types.ts`
- `proto/ladybug_connection.proto`

### Expected modified files

- `src/db/database-adapter.ts`
  Extend factory logic to select remote client behavior for application processes and server-owned behavior where needed.
- `src/config/types.ts`
  Add server/client runtime configuration.
- `src/config/*`
  Validation and defaults for new env vars.
- `src/mcp/server.ts`
  No direct DB lifecycle assumptions beyond adapter creation.
- `src/query/server.ts`
  Continue to accept a `DatabaseAdapter`, but use client mode in deployment.
- CLI entrypoints
  Remove any logic that assumes they directly own LadybugDB lifecycle when in client mode.

## Testing Strategy

### Unit tests

- adapter factory mode selection
- remote adapter request/response mapping
- protobuf/client/server contract validation
- queueing and timeout behavior

### Integration tests

- one connection server with concurrent MCP/query/CLI clients
- graceful shutdown while requests are active
- indexing plus concurrent query traffic
- server restart and client retry behavior

### Regression tests

- no WAL corruption after repeated mixed-process runs
- no local file lock contention in client mode
- response equivalence between the old embedded path and the new server/client path during migration

## Open Questions

1. Does LadybugDB safely support multiple simultaneous `Connection` objects within one owning process under heavy write load, or should the server serialize all DB execution through one connection?
2. Should embedding generation remain client-side permanently, or be centralized later for consistency?
3. Is Unix socket transport worth adding early for local-only deployments?
4. Do we need request batching for chatty query flows, especially `runCypher`-heavy paths?
5. Which Node gRPC stack should be standard here: `@grpc/grpc-js` with generated types, or a higher-level RPC layer built on protobuf definitions?

## Recommendation

Proceed with the standalone gRPC connection server.

This is the smallest architectural change that directly addresses the real problem shown in the current codebase: **embedded LadybugDB ownership is process-local, but Typocop usage is becoming multi-process**. A single DB-owning server with client-backed adapters preserves most of the existing application structure while removing lock/WAL correctness risks.
