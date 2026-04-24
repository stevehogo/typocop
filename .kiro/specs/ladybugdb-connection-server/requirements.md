# Requirements Document

**Related documents:**
- [Server & Runtime Requirements](./requirements-server.md)
- [Client & Operations Requirements](./requirements-client.md)

## Introduction

This document specifies the requirements for the LadybugDB Connection Server — a standalone process that owns the single embedded LadybugDB instance for a given `dbPath` and exposes a local gRPC API. All other Typocop processes (MCP server, CLI indexer, query server) become thin clients via a `RemoteDatabaseAdapter` that implements the existing `DatabaseAdapter` interface.

## Glossary

- **Connection_Server**: The standalone process that owns the LadybugDB file lock and serves gRPC requests
- **EmbeddedDatabaseRuntime**: Component wrapping LadybugDB lifecycle (open, schema init, WAL flush, close)
- **RemoteDatabaseAdapter**: Client-side `DatabaseAdapter` implementation that proxies operations over gRPC
- **RequestScheduler**: Server-side component enforcing concurrency limits, priority queuing, and timeouts
- **AutostartManager**: Client-side logic coordinating on-demand server startup via cross-process lock
- **OperationRouter**: Server component mapping gRPC requests to graph/vector operations with prefix context
- **MetricsCollector**: Server component collecting and exposing health and performance metrics
- **Discovery_File**: JSON file recording PID, URL, prefix, and dbPath of a running server instance
- **TYPOCOP_PREFIX**: Tenant/schema prefix isolating labels, relationship types, and storage paths
- **Adapter_Factory**: The `createDatabaseAdapter(config)` function selecting embedded or remote adapter by runtime mode

## Requirements

Requirements are split across two sub-documents:

1. [Server & Runtime Requirements](./requirements-server.md) — Covers configuration, EmbeddedDatabaseRuntime, gRPC services, RequestScheduler, observability, and security (Requirements 1–5)
2. [Client & Operations Requirements](./requirements-client.md) — Covers RemoteDatabaseAdapter, AutostartManager, multi-tenancy, migration, and adapter factory (Requirements 6–10)
