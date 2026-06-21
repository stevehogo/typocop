# Architecture Overview

> **Status:** Current (as-built) · **Updated:** 2026-06-21
>
> High-level overview of the Code Graph Analyzer (Typocop) as it stands today: a
> **five-layer TypeScript codebase** backed by a **single embedded LadybugDB
> (Kùzu) store** for both graph and vectors, fronted by a CLI (write path) and an
> MCP server (read path), with an optional gRPC connection server for
> remote/shared access.
>
> For the per-module spec, see
> [`docs/refactoring/TARGET-ARCHITECTURE.md`](refactoring/TARGET-ARCHITECTURE.md).

---

## 1. Layered architecture

`src/` is organized into five layers with a strict, lint-enforced dependency
direction (inner layers never import outer ones):

```
apps/            (executables: cli, mcp-server, ladybug-server, query-api)
  │  may use ▼
application/     (use-cases: indexing, querying, export-render)
  │  may use ▼
infrastructure/  (adapters: persistence, embeddings, parsing, git, watch, cache, remote-transport)
  │  may use ▼
platform/        (cross-cutting: config, logging, security, utils, bootstrap)
  │  may use ▼
core/            (pure domain: domain.ts, file-node.ts, ports/) — leaf, no internal deps
```

| Layer | Path | Responsibility | May depend on |
|-------|------|----------------|---------------|
| **core** | `src/core/` | Pure domain types (`domain.ts`), `ports/` (interfaces like `GraphAdapter`, `DatabaseAdapter`, `GitPort`). No I/O. | nothing (leaf) |
| **platform** | `src/platform/` | Config (`ConfigurationManager`, prefix rules), logging, security/privacy, `utils/` (limits, entry-point names), `bootstrap` (env loading). | core |
| **infrastructure** | `src/infrastructure/` | Concrete adapters: `persistence/` (LadybugDB graph/vector), `embeddings/` (HuggingFace/Ollama/noop), `parsing/` (tree-sitter), `git/`, `watch/`, `cache/`, `remote-transport/` (gRPC client). | core, platform |
| **application** | `src/application/` | Use-cases: `indexing/` (the 6-phase pipeline), `querying/` (read tools), `export-render/` (Obsidian). | core, platform, infrastructure |
| **apps** | `src/apps/` | Executables: `cli/`, `mcp-server/`, `ladybug-server/`, `query-api/`. | all of the above |

**Enforced by `dependency-cruiser`** (`.dependency-cruiser.cjs`):
`core-is-leaf`, `platform-only-core`, `infra-no-up`, `app-no-up`, plus
`*-no-sibling` rules forbidding cross-imports between sibling modules within a
layer (e.g. one `application/<x>/` module may not import another
`application/<y>/`). `remote-transport/` is the one whitelisted infrastructure
sibling-crosser. Run `pnpm depcruise src` to verify.

## 2. Executables

`package.json` ships three binaries plus a hook:

| Binary | Entry | Role |
|--------|-------|------|
| `typocop` | `dist/apps/cli/main.js` | **Write path** — `parse` / `reindex` / `status` / `obsidian` / `watch`, embedding setup (`hf`/`ollama`) |
| `typocop-mcp` | `dist/apps/mcp-server/main.js` | **Read path** — Model Context Protocol server for AI editors |
| `typocop-ladybug-server` | `dist/apps/ladybug-server/main.js` | gRPC host exposing the embedded DB for remote/shared access |
| `typocop-hook` | `hooks/claude/typocop-hook.cjs` | Claude Code hook integration |

## 3. System components

```
        WRITE PATH                                READ PATH
┌──────────────────────┐                ┌────────────────────────────┐
│  CLI (typocop)       │                │  MCP server (typocop-mcp)  │
│  parse / reindex /   │                │  11 read-only tools        │
│  watch / obsidian    │                │  + query-api (Fastify)     │
└──────────┬───────────┘                └─────────────┬──────────────┘
           │                                          │
           ▼                                          │
┌────────────────────────────────────┐               │
│   Indexing Pipeline                 │               │
│   src/application/indexing/         │               │
│      pipeline.ts                    │               │
│   1 Structure  → walk file tree     │               │
│   2 Parsing    → tree-sitter        │               │
│   3 Resolution → resolve refs (MRO) │               │
│   4 Clustering → Louvain            │               │
│   5 Processes  → trace flows        │               │
│   6 Search     → build indexes      │               │
└──────────────┬──────────────────────┘               │
               │                                       │
               ▼                                       ▼
   ┌─────────────────────────────────────────────────────────┐
   │  LadybugDB (Kùzu) — embedded graph + vector store         │
   │  • graph:  Symbol / Cluster / Process / Metadata /        │
   │            ExternalDependency nodes + typed edges         │
   │  • vectors: symbol & cluster embeddings (HNSW)            │
   └─────────────────────────────────────────────────────────┘
         ▲  in-process                  ▲  gRPC (remote/shared)
         │                              │
   local adapters                 typocop-ladybug-server
   (LadybugGraph/VectorAdapter)   (router · services · scheduler · discovery)
               ▲
               │ MCP protocol
   ┌────────────────────────────────────────────┐
   │ AI Editors (Kiro, Claude, Cursor, Windsurf, │
   │ Antigravity)                                │
   └────────────────────────────────────────────┘
```

## 4. Storage — single embedded LadybugDB (Kùzu)

A single embedded **LadybugDB (Kùzu-backed)** engine holds both the graph and the
vectors (`src/infrastructure/persistence/`):

- **`LadybugGraphAdapter`** — graph reads/writes via Kùzu's `Connection.query()` /
  `prepare()`+`execute()` (parameterized). All labels/edge types are **prefixed**
  (default `tpc_`) so multiple Typocop instances can share one DB.
- **`LadybugVectorAdapter`** — symbol/cluster embeddings + similarity search.

**Node labels:** `Symbol`, `Cluster`, `Process`, `Metadata`, `ExternalDependency`.

**Edge (`RelationType`) types** (`core/domain.ts`): `calls`, `imports`,
`inherits`, `implements`, `contains`, `references`, `defines`, `dependsOn`, plus
the MRO-derived `overrides` and `methodImplements` (additive, never replacing
`inherits`/`implements`). Persisted upper-cased and prefixed (e.g. `tpc_CALLS`).

**Identity (A1 keystone):** every persisted node id / edge endpoint is a stable,
position-independent `logicalKey` (derived from filePath + qualified name + kind +
per-file ordinal), so a symbol moving within its file keeps its identity.

### Embeddings (pluggable)

`src/infrastructure/embeddings/` — provider chosen by `EMBEDDING_PROVIDER`:

- **HuggingFace** (default/recommended) — in-process `mixedbread-ai/mxbai-embed-large-v1`, no external service.
- **Ollama** — local embedding service (e.g. 2560-dim models).
- **none** — semantic search disabled (faster indexing; `smart_search` degrades gracefully).

Embedding dimensionality is **variable** (provider-dependent).

## 5. Write path — the 6-phase indexing pipeline

`runIndexingPipeline` (`src/application/indexing/pipeline.ts`) orchestrates:

```
Phase 1 (Structure)  → FileNode[]
  └─> Phase 2 (Parsing, tree-sitter)        → Symbol[]
      └─> Phase 3 (Resolution, MRO/C3)      → Relationship[]
          ├─> Phase 4 (Clustering, Louvain) → Cluster[]   ─┐
          └─> Phase 5 (Processes)           → Process[]   ─┤
                                                           └─> Phase 6 (Search index)
```

- Phases run **sequentially** (each depends on the prior), with **early exit** on
  empty results and optional **verbose** progress logging.
- Phase 2 also computes per-callable **complexity metrics** (cyclomatic /
  cognitive / maxLoopDepth) and, for framework routes/consumers, response/accessed
  **keys** (used by `shape_check`).
- Phase 3 resolution is MRO-aware (C3 linearization) for `overrides`/`methodImplements`.
- Results are written to LadybugDB (graph + vectors). `reindex --refresh` does a
  full rebuild; the file watcher does incremental re-indexing of changed files.

## 6. Connection server (remote / shared DB access)

`src/apps/ladybug-server/` + `src/infrastructure/remote-transport/` provide a
**gRPC** front for the embedded DB so multiple clients share one graph
(`LADYBUG_RUNTIME_MODE=client|server`, default port `7617`):

- **Autostart** — a client with `LADYBUG_SERVER_AUTOSTART=true` spawns the server
  on demand and connects via a **discovery file** (host/port/token).
- **Resilience** — **WAL self-heal** (quarantines a corrupt WAL and retries),
  **stale-lock reclaim** (a lock whose PID is dead is reclaimed), and
  kill-and-respawn of a wedged server on startup timeout.
- **Scheduling** — a priority request scheduler with a bounded queue
  (`maxConcurrency` / `maxQueue`) protects the single-writer DB.
- The server's graph service binds query parameters (`paramsJson`) and runs
  backend-compatible Cypher (`label(e)`, `CAST(… AS INT64)`, pattern predicates).

## 7. Read path — querying & the MCP server

### Query layer (`src/application/querying/`)

Read use-cases over the graph/vectors, all reusing a shared
`resolveSymbol` (exact → fuzzy → not-found + suggestions):

- `context-retrieval` / `context-slice` (token-budgeted), `smart-search` (semantic),
  `impact-analysis` (+ `explainability` roles), `trace-path` (shortest path),
  `data-flow-trace`, `dead-code`, `hotspots`, `shape-check`, `rename-plan`,
  `pre-commit-check` / `changed-symbols`, and the **grounding** stack
  (`verify-claim`, `verify-claim-types` grader, `verify-usage` / `verify-edge` /
  `verify-reach`).

### MCP server (`src/apps/mcp-server/`)

Exposes **11 read-only tools** (none mutate code or the graph); every response
carries a mandatory human-readable `summary`. See
[`src/apps/mcp-server/README.md`](../src/apps/mcp-server/README.md) for full
parameters and the additive per-tool response fields.

| Tool | Purpose |
|------|---------|
| `get_symbol_context` | 360° context (callers/callees/clusters/processes); optional token-budgeted slicing |
| `smart_search` | Natural-language → symbols (semantic similarity) |
| `impact_analysis` | Blast radius: direct + transitive dependents, flows, risk, per-node role/edge/hop (`maxDepth`) |
| `trace` | Shortest call/containment path between two symbols |
| `trace_data_flow` | Data flow from an API entry point through services to DB models |
| `find_dead_code` | Uncalled, non-exported, non-entry-point candidates |
| `find_hotspots` | Most complex symbols (cyclomatic/cognitive/maxLoopDepth) |
| `shape_check` | API contract drift — graph-wide, or scoped to one `route` (drift + blast radius) |
| `rename` | **Preview** a coordinated rename (edge-backed edits + regex tail); never writes |
| `detect_changes` | Blast radius of uncommitted/git changes (CRITICAL for auth/payment/etc.) |
| `verify_claim` | **Grounding/anti-hallucination** — verify a usage/edge/reachability claim → verdict + confidence + evidence; unprovable → honest `uncertain`; a refute carries the true answer |

The server validates requests, supports token auth, and tracks per-session
connection state. The `query-api/` (Fastify) app offers an alternative HTTP read
surface over the same query layer.

## 8. Key design decisions

- **Five-layer dependency inversion** — adapters behind `core/ports` interfaces;
  enforced by dependency-cruiser, keeping the domain pure and swappable.
- **One embedded store** — LadybugDB holds graph *and* vectors in a single
  file (no separate graph/vector services to operate).
- **Stable `logicalKey` identity** — survives intra-file moves (A1 keystone).
- **Honest-uncertainty (grounding)** — `verify_claim` never converts a
  graph-unprovable relationship (dynamic dispatch / callbacks / DI) into a false
  confirm/refute; it returns `uncertain` with a reason.
- **Graceful degradation** — read tools resolve fuzzily and never throw to the
  agent; unresolved symbols return suggestions; timeouts/clamps bound traversal
  (`MAX_TRAVERSAL_DEPTH`, `withQueryTimeout`).
- **Prefix isolation** — all labels/edges carry a configurable prefix (`tpc_`).

## 9. Performance & testing

- **Indexing throughput** target ≥10,000 LOC/s; sequential phases with bounded
  memory; HNSW vector index for sub-second similarity search.
- **Read tools** clamp traversal depth/branching and wrap queries in timeouts.
- **Testing** — unit (mock adapters), integration (query-aware in-memory graph),
  and property tests (fast-check). Note: unit tests mock `runCypher`, so
  backend-Cypher compatibility is validated separately against a live LadybugDB.
- Gates: `pnpm typecheck && pnpm typecheck:tests && pnpm depcruise src && pnpm test`.

## 10. Related documentation

- [`docs/refactoring/TARGET-ARCHITECTURE.md`](refactoring/TARGET-ARCHITECTURE.md) — per-module spec and file map.
- [`src/apps/mcp-server/README.md`](../src/apps/mcp-server/README.md) — MCP tool reference.
- [`README.md`](../README.md) — project overview, setup, and usage.
