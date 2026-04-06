Part of the [Memgraph + Qdrant Migration Design](./design.md).

---

# Data Models, Infrastructure & Testing

## Qdrant Collection Schema

Qdrant has no dimension limit, so `QdrantAdapter` uses the full **3072 dims** from `text-embedding-3-large`. `PgvectorAdapter` stays at 1536 (pgvector HNSW index cap is 2000). Each adapter requests the appropriate dimension from the OpenAI API via the `dimensions` parameter.

| pgvector column | Qdrant concept | Notes |
|---|---|---|
| `symbol_id` TEXT PK | point `id` (string) | Used directly as string id |
| `embedding vector(3072)` | vector `"default"` | **3072** dims, cosine distance |
| `metadata JSONB` | point `payload` | Arbitrary key-value pairs |

Collection config:
```typescript
{
  vectors: { size: 3072, distance: "Cosine" },  // full OpenAI dims
  hnsw_config: { m: 16, ef_construct: 100 },
  optimizers_config: { indexing_threshold: 0 },
}
```

| Adapter | Dimensions | OpenAI model | Notes |
|---|---|---|---|
| `QdrantAdapter` | **3072** | `text-embedding-3-large` | Full resolution, better recall |
| `PgvectorAdapter` | 1536 | `text-embedding-3-large` (truncated) | pgvector HNSW cap is 2000 |

---

## Environment Variables

| Variable | Values | Default | Notes |
|---|---|---|---|
| `GRAPH_BACKEND` | `neo4j` \| `memgraph` | `neo4j` | Selects graph adapter |
| `VECTOR_BACKEND` | `pgvector` \| `qdrant` | `pgvector` | Selects vector adapter |
| `NEO4J_URI` | bolt URI | `bolt://localhost:8687` | Used by Neo4jAdapter |
| `NEO4J_USER` | string | `neo4j` | Used by Neo4jAdapter |
| `NEO4J_PASSWORD` | string | `password` | Used by Neo4jAdapter |
| `MEMGRAPH_URI` | bolt URI | `bolt://localhost:7687` | Used by MemgraphAdapter |
| `MEMGRAPH_USER` | string | `""` | Memgraph has no auth by default |
| `MEMGRAPH_PASSWORD` | string | `""` | Memgraph has no auth by default |
| `POSTGRES_HOST` | hostname | `localhost` | Used by PgvectorAdapter |
| `POSTGRES_PORT` | number | `8432` | Used by PgvectorAdapter |
| `POSTGRES_DB` | string | `typocop` | Used by PgvectorAdapter |
| `POSTGRES_USER` | string | `postgres` | Used by PgvectorAdapter |
| `POSTGRES_PASSWORD` | string | `password` | Used by PgvectorAdapter |
| `QDRANT_URL` | HTTP URL | `http://localhost:6333` | Used by QdrantAdapter |
| `QDRANT_API_KEY` | string | `""` | Optional; for Qdrant Cloud |

---

## Infrastructure Changes

### docker-compose.yml

```yaml
# Add alongside existing services (or replace when fully migrated):
memgraph:
  image: memgraph/memgraph:latest
  ports: ["7687:7687", "7444:7444"]
  volumes: ["./.db-storages/memgraph:/var/lib/memgraph"]
  healthcheck:
    test: ["CMD", "mg_client", "--execute", "RETURN 1;"]
    interval: 10s
    retries: 10

qdrant:
  image: qdrant/qdrant:latest
  ports: ["6333:6333", "6334:6334"]
  volumes: ["./.db-storages/qdrant:/qdrant/storage"]
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:6333/healthz"]
    interval: 10s
    retries: 10
```

### Dependencies

```bash
pnpm add @qdrant/js-client-rest   # add for QdrantAdapter
# pg and @types/pg remain for PgvectorAdapter
# neo4j-driver remains for both graph adapters
```

---

## Error Handling

| Scenario | Response | Recovery |
|---|---|---|
| Graph adapter connection fails (3 attempts) | `withRetry` throws | CLI/MCP startup exits non-zero |
| Vector adapter connection fails (3 attempts) | `withRetry` throws | CLI/MCP startup exits non-zero |
| Qdrant upsert non-200 | `@qdrant/js-client-rest` throws; `withRetry` retries | After 3 failures, pipeline halts |
| Memgraph APOC call | Eliminated — `MemgraphAdapter.storeNodes` has no APOC path | N/A |
| Unknown `GRAPH_BACKEND` value | Factory throws `Error("Unknown graph backend: ...")` | Startup exits non-zero |
| Unknown `VECTOR_BACKEND` value | Factory throws `Error("Unknown vector backend: ...")` | Startup exits non-zero |

---

## Testing Strategy

### Unit Tests

Mock adapters with `vi.fn()` — consumers only call the interface, so mocking is trivial:

```typescript
const mockVectorAdapter: VectorAdapter = {
  createClient: vi.fn().mockResolvedValue({}),
  initVectorStore: vi.fn().mockResolvedValue(undefined),
  indexSymbol: vi.fn().mockResolvedValue(undefined),
  semanticSearch: vi.fn().mockResolvedValue([]),
};
```

Test each concrete adapter in isolation:
- `QdrantAdapter`: mock `@qdrant/js-client-rest`, verify upsert shape and search mapping
- `MemgraphAdapter`: verify no `encrypted` flag, no APOC call in `storeNodes`
- Factories: verify correct adapter class returned for each backend string

### Property-Based Tests (fast-check)

Property 15 (Search Result Ordering) applies to both `PgvectorAdapter` and `QdrantAdapter`:

```typescript
fc.assert(fc.asyncProperty(
  fc.array(fc.record({ id: fc.string(), score: fc.float({ min: 0, max: 1 }) })),
  async (mockHits) => {
    mockSearch.mockResolvedValue(mockHits);
    const results = await adapter.semanticSearch(client, embedding, mockHits.length);
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }
  }
));
```

### Integration Tests

```
tests/integration/
  memgraph-adapter.test.ts   — Bolt connectivity, MERGE idempotency via MemgraphAdapter
  qdrant-adapter.test.ts     — collection init, upsert, search round-trip via QdrantAdapter
  adapter-factory.test.ts    — factory returns correct adapter for each env var value
```

### Regression

Run `pnpm vitest --run` after migration. All existing graph query tests pass unchanged — Cypher queries are identical across both graph adapters.
