Part of the [Memgraph + Qdrant Migration Design](./design.md).

---

# Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — a formal statement about what the system should do.*

---

### Property 1: Factory returns correct adapter for every valid backend value

*For any* valid `GRAPH_BACKEND` value (`"neo4j"` or `"memgraph"`), `createGraphAdapter` SHALL return an instance of the corresponding adapter class; and for any valid `VECTOR_BACKEND` value (`"pgvector"` or `"qdrant"`), `createVectorAdapter` SHALL return an instance of the corresponding adapter class.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

---

### Property 2: Factory throws on unrecognized backend string

*For any* string that is not a member of `{ "neo4j", "memgraph" }` passed to `createGraphAdapter`, or not a member of `{ "pgvector", "qdrant" }` passed to `createVectorAdapter`, the factory SHALL throw an error.

**Validates: Requirements 2.5, 2.6**

---

### Property 3: MemgraphAdapter.storeNodes never invokes APOC

*For any* non-empty array of `GraphNode` objects, calling `MemgraphAdapter.storeNodes` SHALL execute only `MERGE (x:Label {id}) SET x += props` Cypher and SHALL NOT call any procedure whose name begins with `apoc.`.

**Validates: Requirements 3.2**

---

### Property 4: QdrantAdapter indexSymbol upsert shape is correct

*For any* `symbolId` string, `Embedding`, and metadata record, `QdrantAdapter.indexSymbol` SHALL call `client.upsert` with a point whose `id` equals `symbolId`, `vector` equals `embedding.vector`, and `payload` equals the metadata object.

**Validates: Requirements 4.3**

---

### Property 5: QdrantAdapter semanticSearch result mapping round-trip

*For any* array of Qdrant hit objects (each with `id`, `score`, `payload`), `QdrantAdapter.semanticSearch` SHALL return a `SearchResult[]` where each element's `symbolId` equals the hit's `id`, `score` equals the hit's `score`, and `metadata` equals the hit's `payload`.

**Validates: Requirements 4.4**

---

### Property 6: Search results are ordered by score descending

*For any* query embedding and limit, the `SearchResult[]` returned by both `QdrantAdapter.semanticSearch` and `PgvectorAdapter.semanticSearch` SHALL be ordered such that `results[i].score >= results[i+1].score` for all consecutive pairs.

**Validates: Requirements 4.4**

---

### Property 7: indexSymbol then semanticSearch round-trip recovers the symbol

*For any* valid `symbolId` and `Embedding`, after calling `indexSymbol(client, symbolId, embedding, {})`, calling `semanticSearch(client, embedding, 1)` SHALL return a result list whose first element has `symbolId` equal to the indexed id.

**Validates: Requirements 4.3, 4.4**
