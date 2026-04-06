Part of the [Memgraph + Qdrant Migration Design](./design.md).

---

# Components & Adapter Interfaces

## GraphAdapter Interface

```typescript
// src/graph/adapter.ts
import type { Driver, Session } from "neo4j-driver";
import type { GraphNode, GraphEdge } from "./connection.js";

export interface GraphAdapter {
  createDriver(uri: string, user: string, password: string): Promise<Driver>
  storeNodes(session: Session, nodes: GraphNode[]): Promise<void>
  storeEdges(session: Session, edges: GraphEdge[]): Promise<void>
  findNode(session: Session, idOrName: string): Promise<GraphNode | null>
  findDependents(session: Session, symbolId: string): Promise<GraphNode[]>
  findDependencies(session: Session, symbolId: string): Promise<GraphNode[]>
  traversePath(session: Session, from: string, to: string): Promise<GraphEdge[][]>
  findProcessesBySymbol(session: Session, symbolId: string): Promise<GraphNode[]>
  findClustersBySymbol(session: Session, symbolId: string): Promise<GraphNode[]>
}
```

## VectorAdapter Interface

```typescript
// src/vector/adapter.ts
import type { Embedding, SearchResult } from "../types/index.js";

export type VectorClient = Pool | QdrantClient;  // opaque to consumers

export interface VectorConfig {
  // pgvector: { host, port, database, user, password }
  // qdrant:   { url, apiKey? }
  [key: string]: unknown;
}

export interface VectorAdapter {
  createClient(config: VectorConfig): Promise<VectorClient>
  initVectorStore(client: VectorClient): Promise<void>
  indexSymbol(
    client: VectorClient,
    symbolId: string,
    embedding: Embedding,
    metadata?: Record<string, string>,
  ): Promise<void>
  semanticSearch(
    client: VectorClient,
    queryEmbedding: Embedding,
    limit: number,
  ): Promise<SearchResult[]>
}
```

---

## Concrete Graph Adapters

### Neo4jAdapter (`src/graph/neo4j-adapter.ts`)

Wraps existing `connection.ts`, `store.ts`, `query.ts` — behavior unchanged.

```typescript
export class Neo4jAdapter implements GraphAdapter {
  async createDriver(uri, user, password) {
    // existing createDriver() — keeps encrypted: false for Neo4j 5
  }
  async storeNodes(session, nodes) {
    // existing storeNodes() — APOC path + fallback
  }
  // ... delegates to existing query.ts functions
}
```

### MemgraphAdapter (`src/graph/memgraph-adapter.ts`)

Same Bolt protocol, two differences:

```typescript
export class MemgraphAdapter implements GraphAdapter {
  async createDriver(uri, user, password) {
    // removes encrypted: false — Memgraph negotiates correctly without it
    return withRetry(async () => {
      const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
      await driver.verifyConnectivity();
      return driver;
    });
  }
  async storeNodes(session, nodes) {
    // APOC path removed — only the MERGE fallback loop
    for (const n of batch) {
      await session.executeWrite(tx =>
        tx.run(`MERGE (x:${label} {id: $id}) SET x += $props`, { id, props })
      );
    }
  }
  // ... all query methods identical to Neo4jAdapter (same Cypher)
}
```

---

## Concrete Vector Adapters

### PgvectorAdapter (`src/vector/pgvector-adapter.ts`)

Wraps existing `connection.ts`, `index-store.ts`, `search.ts` — behavior unchanged.

```typescript
export class PgvectorAdapter implements VectorAdapter {
  async createClient(config) { return createPool(config as PgConfig); }
  async initVectorStore(client) { /* existing pgvector init */ }
  async indexSymbol(client, symbolId, embedding, metadata) { /* existing INSERT ON CONFLICT */ }
  async semanticSearch(client, queryEmbedding, limit) { /* existing cosine query */ }
}
```

### QdrantAdapter (`src/vector/qdrant-adapter.ts`)

New implementation using `@qdrant/js-client-rest`:

```typescript
export class QdrantAdapter implements VectorAdapter {
  async createClient(config: { url: string; apiKey?: string }) {
    return withRetry(async () => {
      const client = new QdrantClient({ url: config.url, apiKey: config.apiKey });
      await client.getCollections(); // verify connectivity
      return client;
    });
  }
  async initVectorStore(client: QdrantClient) {
    const { collections } = await client.getCollections();
    if (!collections.find(c => c.name === "embeddings")) {
      await client.createCollection("embeddings", {
        vectors: { size: 3072, distance: "Cosine" },  // full OpenAI dims
        hnsw_config: { m: 16, ef_construct: 100 },
      });
    }
  }
  async indexSymbol(client, symbolId, embedding, metadata = {}) {
    await client.upsert("embeddings", {
      points: [{ id: symbolId, vector: embedding.vector, payload: metadata }],
      wait: true,
    });
  }
  async semanticSearch(client, queryEmbedding, limit) {
    const hits = await client.search("embeddings", {
      vector: queryEmbedding.vector, limit, with_payload: true,
    });
    return hits.map(h => ({ symbolId: h.id as string, score: h.score, metadata: h.payload ?? {} }));
  }
}
```

---

## Factory Functions

```typescript
// src/graph/adapter-factory.ts
export function createGraphAdapter(backend: 'neo4j' | 'memgraph'): GraphAdapter {
  return backend === 'memgraph' ? new MemgraphAdapter() : new Neo4jAdapter();
}

// src/vector/adapter-factory.ts
export function createVectorAdapter(backend: 'pgvector' | 'qdrant'): VectorAdapter {
  return backend === 'qdrant' ? new QdrantAdapter() : new PgvectorAdapter();
}
```

Consumers call the factory once at startup:

```typescript
const graphBackend = (process.env.GRAPH_BACKEND ?? 'neo4j') as 'neo4j' | 'memgraph';
const vectorBackend = (process.env.VECTOR_BACKEND ?? 'pgvector') as 'pgvector' | 'qdrant';

const graphAdapter = createGraphAdapter(graphBackend);
const vectorAdapter = createVectorAdapter(vectorBackend);
```

---

## Consumer Update Map

All consumers switch from concrete types to adapter interfaces. No query logic changes.

| File | Change |
|---|---|
| `src/cli/executor.ts` | Call factories; pass `graphAdapter` + `vectorAdapter` instead of `driver` + `pool` |
| `src/mcp/server.ts` | Same pattern as executor.ts |
| `src/indexer/pipeline.ts` | `PipelineConfig.vectorPool: Pool` → `vectorAdapter: VectorAdapter` |
| `src/query/smart-search.ts` | Accept `VectorAdapter` + `VectorClient` instead of `Pool` |
| `src/mcp/handler.ts` | Accept `VectorAdapter` + `VectorClient` instead of `Pool` |
| `src/mcp/tools.ts` | Accept `VectorAdapter` + `VectorClient` instead of `Pool` |
