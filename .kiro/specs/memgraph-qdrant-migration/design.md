# Design Document: Memgraph + Qdrant Migration

**Related documents:**
- [Components & Adapter Interfaces](./design-components.md)
- [Data Models, Infrastructure & Testing](./design-data-models.md)
- [Correctness Properties](./design-correctness.md)

---

## Overview

Introduce an **adapter pattern** for both the graph and vector storage layers so that Neo4j + pgvector (existing) and Memgraph + Qdrant (new) can coexist and be switched via environment variables — with zero changes to any consumer.

Two adapter interfaces are defined (`GraphAdapter`, `VectorAdapter`). Two concrete implementations exist for each. A factory function reads `GRAPH_BACKEND` / `VECTOR_BACKEND` env vars and returns the correct adapter. All consumers program against the interface only.

---

## Architecture

### Adapter Layer (target state)

```mermaid
graph TD
    CLI[CLI / MCP Server]
    GF[createGraphAdapter\nsrc/graph/adapter-factory.ts]
    VF[createVectorAdapter\nsrc/vector/adapter-factory.ts]
    GA[GraphAdapter interface]
    VA[VectorAdapter interface]
    N4J[Neo4jAdapter\nneo4j-driver → :8687]
    MG[MemgraphAdapter\nneo4j-driver → :7687]
    PG[PgvectorAdapter\npg Pool → :8432]
    QD[QdrantAdapter\n@qdrant/js-client-rest → :6333]

    CLI --> GF
    CLI --> VF
    GF --> GA
    VF --> VA
    GA --> N4J
    GA --> MG
    VA --> PG
    VA --> QD
```

### Backend Selection Flow

```mermaid
graph LR
    ENV{GRAPH_BACKEND\nVECTOR_BACKEND}
    ENV -->|neo4j| N4J[Neo4jAdapter]
    ENV -->|memgraph| MG[MemgraphAdapter]
    ENV -->|pgvector| PG[PgvectorAdapter]
    ENV -->|qdrant| QD[QdrantAdapter]
```

---

## Sequence Diagrams

### Indexing Flow (adapter-aware)

```mermaid
sequenceDiagram
    participant P as pipeline.ts
    participant GA as GraphAdapter
    participant VA as VectorAdapter
    participant DB as Graph DB (Neo4j or Memgraph)
    participant VS as Vector Store (pgvector or Qdrant)

    P->>GA: storeNodes(session, nodes)
    GA->>DB: MERGE (x:Label {id}) SET x += props
    DB-->>GA: ok

    P->>GA: storeEdges(session, edges)
    GA->>DB: MATCH (a),(b) MERGE (a)-[r:TYPE]->(b)
    DB-->>GA: ok

    P->>VA: indexSymbol(client, symbolId, embedding, metadata)
    VA->>VS: upsert point / INSERT ON CONFLICT
    VS-->>VA: ok
```

### Semantic Search Flow (adapter-aware)

```mermaid
sequenceDiagram
    participant Q as smart-search.ts
    participant VA as VectorAdapter
    participant VS as Vector Store (pgvector or Qdrant)

    Q->>VA: semanticSearch(client, queryEmbedding, limit)
    VA->>VS: cosine search query
    VS-->>VA: hits with scores
    VA-->>Q: SearchResult[]
```

---

## Adapter Pattern Overview

### Why Adapters

The existing codebase has `Pool` (pg) and `Driver` (neo4j-driver) types scattered across consumers. Introducing adapters means:

- Consumers never import from `pg` or `@qdrant/js-client-rest` directly
- Switching backends is a one-line env var change
- Both backends can be tested in isolation with the same test suite
- The Neo4j adapter preserves all existing behavior exactly — zero regression risk

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Keep `neo4j-driver` for both graph adapters | Memgraph is Bolt-compatible; same driver, different URI |
| `Neo4jAdapter` removes `encrypted: false` flag | Memgraph default Bolt is unencrypted; flag is Neo4j-specific |
| `Neo4jAdapter` removes APOC path in `storeNodes` | Memgraph has no APOC; fallback MERGE is the only path needed |
| `VectorAdapter.createClient` returns opaque `VectorClient` | Hides `Pool` vs `QdrantClient` from all consumers |
| Factory reads env vars at startup, not per-call | Adapter is created once and injected; no runtime overhead |

See [Components & Adapter Interfaces](./design-components.md) for full interface definitions and factory implementations.
