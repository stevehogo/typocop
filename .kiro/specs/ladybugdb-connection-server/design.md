# Design Document: LadybugDB Connection Server

**Related documents:**
- [Components & Interfaces](./design-components.md)
- [Data Models & Algorithms](./design-data-models.md)
- [Algorithmic Pseudocode](./design-algorithms.md)
- [Correctness Properties](./design-properties.md)
- [Error Handling & Testing](./design-correctness.md)

## Overview

Typocop currently treats LadybugDB as an embedded, per-process resource. The CLI, MCP server, and query server each create their own `DatabaseAdapter`, which acquires a local LadybugDB connection and relies on careful shutdown to flush WAL state and release the file lock. This works inside a single process but produces WAL corruption and lock contention when multiple processes access the same database concurrently.

This design introduces a standalone **LadybugDB Connection Server** — a single process that owns the only embedded LadybugDB instance for a given `dbPath` and exposes a local gRPC API. All other Typocop processes (MCP server, CLI indexer, query server) become thin clients via a `RemoteDatabaseAdapter` that implements the existing `DatabaseAdapter` interface.

The architecture uses on-demand autostart with cross-process locking and a discovery file so that any client process can transparently start the server if it is not already running. Multi-tenancy is preserved through `TYPOCOP_PREFIX`, with each prefix getting its own server instance, database file, lock, and discovery path by default.

## Architecture

### System Topology

```mermaid
graph TD
    subgraph ConnectionServer["LadybugDB Connection Server (single process)"]
        EDB[EmbeddedDatabaseRuntime]
        OR[OperationRouter]
        RS[RequestScheduler]
        MC[MetricsCollector]
        GRPC[gRPC Server]
    end

    subgraph Clients["Typocop Client Processes"]
        MCP[MCP Server]
        CLI[CLI Indexer]
        QS[Query Server]
    end

    MCP -->|gRPC| GRPC
    CLI -->|gRPC| GRPC
    QS -->|gRPC| GRPC

    GRPC --> OR
    OR --> RS
    RS --> EDB
    EDB --> LDB[(LadybugDB File)]
    OR --> MC
```

### Adapter Selection Flow

```mermaid
graph TD
    A[createDatabaseAdapter config] --> B{config.ladybug.runtimeMode}
    B -->|server| C[LadybugDatabaseAdapter<br/>embedded, owns DB lock]
    B -->|client| D[RemoteDatabaseAdapter<br/>gRPC proxy to server]
    D --> E{Health.Check OK?}
    E -->|yes| F[Return RemoteDatabaseAdapter]
    E -->|no| G{AUTOSTART enabled?}
    G -->|no| H[Fail: server unavailable]
    G -->|yes| I[AutostartManager.ensureServer]
    I --> J[Acquire cross-process lock]
    J --> K[Re-check Health.Check]
    K -->|healthy| L[Release lock, return adapter]
    K -->|unhealthy| M[Spawn server, poll readiness]
    M --> N[Write discovery file]
    N --> L
```

### Client Request Lifecycle

```mermaid
sequenceDiagram
    participant Client as MCP/CLI/Query
    participant RDA as RemoteDatabaseAdapter
    participant GRPC as gRPC Transport
    participant Router as OperationRouter
    participant Sched as RequestScheduler
    participant DB as EmbeddedDatabaseRuntime

    Client->>RDA: graphAdapter.queryNodes("Symbol")
    RDA->>GRPC: Graph.QueryNodes(label, filter, prefix)
    GRPC->>Router: dispatch(QueryNodes)
    Router->>Sched: enqueue(priority=INTERACTIVE_READ)
    Sched->>DB: execute query
    DB-->>Sched: rows[]
    Sched-->>Router: result
    Router-->>GRPC: QueryNodesResponse
    GRPC-->>RDA: deserialized GraphNode[]
    RDA-->>Client: GraphNode[]
```

### Autostart Sequence

```mermaid
sequenceDiagram
    participant Client as Client Process
    participant Lock as Cross-Process Lock
    participant Disc as Discovery File
    participant Server as Connection Server

    Client->>Server: Health.Check (short deadline)
    Server-->>Client: UNAVAILABLE
    Client->>Lock: acquire(LOCK_PATH)
    Lock-->>Client: locked
    Client->>Server: Health.Check (re-check)
    Server-->>Client: UNAVAILABLE
    Client->>Server: spawn detached process
    loop Poll readiness
        Client->>Server: Health.Check
        Server-->>Client: SERVING (once ready)
    end
    Client->>Disc: write { pid, url, prefix, dbPath }
    Client->>Lock: release
    Client->>Client: create RemoteDatabaseAdapter
```

### Graceful Shutdown Sequence

```mermaid
sequenceDiagram
    participant Admin as Admin/Signal
    participant Server as Connection Server
    participant Sched as RequestScheduler
    participant DB as EmbeddedDatabaseRuntime

    Admin->>Server: SIGTERM / Admin.Shutdown
    Server->>Server: stop accepting new connections
    Server->>Sched: drain (reject new, wait in-flight)
    Sched-->>Server: all drained
    Server->>DB: close database (flush WAL)
    DB-->>Server: closed
    Server->>Server: remove discovery file
    Server->>Server: exit(0)
```
