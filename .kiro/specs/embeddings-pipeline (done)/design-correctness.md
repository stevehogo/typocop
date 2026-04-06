Part of the [Embeddings Pipeline Design](./design.md).

# Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do.*

---

### Property 1: embedFn is non-null iff API key is present

*For any* environment configuration, the `embedFn` passed to `buildSearchIndex` is a callable function if and only if `OPENAI_API_KEY` is a non-empty string in `process.env`; otherwise it is `null`.

**Validates: Requirements 1.1, 1.2**

---

### Property 2: SearchIndex collects exactly the non-null embedding results

*For any* list of clusters and any `embedFn` that returns `Embedding | null` per cluster, `SearchIndex.embeddings` contains exactly one `EmbeddingResult` for each cluster where `embedFn` returned a non-null value, and zero entries for clusters where it returned `null` or where `embedFn` is `null`.

**Validates: Requirements 2.1, 2.2**

---

### Property 3: SearchIndex structural invariants

*For any* input `symbols` array and `clusters` array, `SearchIndex.symbolCount` equals `symbols.length`, and each `EmbeddingResult.symbolId` equals `cluster.symbols[0]` for its corresponding cluster.

**Validates: Requirements 2.3, 2.4**

---

### Property 4: indexSymbol called exactly once per EmbeddingResult

*For any* `SearchIndex.embeddings` array of length N, the PipelineOrchestrator calls `indexSymbol` exactly N times — once per entry — and `PipelineResult.embeddingCount` equals N.

**Validates: Requirements 3.1, 3.4**

---

### Property 5: OpenAI failure skips cluster, pipeline continues

*For any* set of clusters where a subset causes `embedFn` to return `null` (simulating API failure), the pipeline completes successfully, skips those clusters, and `embeddingCount` reflects only the clusters that succeeded.

**Validates: Requirements 3.2**
