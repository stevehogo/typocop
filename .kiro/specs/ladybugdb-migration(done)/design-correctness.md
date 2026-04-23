# Design: Correctness Properties

## Property 1: Graph Integrity Preservation

**∀ node N in Neo4j graph: N exists in LadybugDB with identical properties after migration.**

For all symbols, relationships, clusters, and processes stored in Neo4j, the LadybugDB `GraphAdapter` must produce identical results when queried with the same Cypher queries. Prefix isolation must be preserved.

## Property 2: Prefix Isolation

**∀ prefix P, ∀ query Q: results(Q, P) ∩ results(Q, P') = ∅ where P ≠ P'.**

The `GraphAdapter` and `VectorAdapter` must enforce prefix isolation. Nodes with label `tpc_Symbol` must never appear in queries scoped to prefix `dev_`, and vice versa.

## Property 3: Vector Search Score Ordering

**∀ search results R: R[i].score ≥ R[i+1].score for all valid i.**

Semantic search results from `VectorAdapter.semanticSearch()` must be ordered by descending similarity score.

## Property 4: Vector Search Threshold

**∀ result r in semanticSearch(): r.score ≥ SEMANTIC_SEARCH_THRESHOLD (0.70).**

No search result may have a score below the configured threshold.

## Property 5: Embedding Dimension Consistency

**∀ embedding E: E.vector.length === E.dimensions.**

Every `Embedding` object produced by any `EmbeddingAdapter` must have a vector whose length matches the declared dimensions.

## Property 6: Ollama Disabled Default

**When OLLAMA_ENABLED is unset or "false": EmbeddingAdapter.isEnabled() === false ∧ embedText() returns null.**

The system must function without semantic search when Ollama is disabled (the default). All graph-based queries (impact analysis, context retrieval, data flow trace) must work normally.

## Property 7: NoOp Embedding Graceful Degradation

**When embeddings are disabled: smartSearch falls back to keyword-only search or returns empty results.**

The query layer must not throw when `EmbeddingAdapter.isEnabled()` returns false. Smart search degrades gracefully.

## Property 8: Configuration Validation

**∀ config C loaded from env: C.prefix matches /^[a-z][a-z0-9_]*$/ ∧ C.prefix.length ≤ 32.**

Existing prefix validation rules must be preserved. New Ollama config must validate URL format and positive dimension values.

## Property 9: Adapter Interface Completeness

**∀ operation O in current GraphStore ∪ VectorStore: ∃ equivalent operation in GraphAdapter ∪ VectorAdapter.**

The adapter interfaces must cover every operation currently used by the query layer and indexer. No functionality regression.

## Property 10: LadybugDB Cypher Compatibility

**∀ Cypher query Q currently executed against Neo4j: Q produces equivalent results against LadybugDB.**

All existing Cypher queries (MERGE, MATCH, DETACH DELETE, pattern matching) must work unchanged through LadybugDB's auto-transpilation.

## Property 11: Connection Retry Resilience

**∀ transient failure F during connection: system retries up to 3 times with exponential backoff.**

The `withRetry` pattern from current Neo4j/PostgreSQL connections must be preserved for LadybugDB connections.

## Property 12: Privacy Preservation

**∀ text T sent to Ollama: T contains only symbol metadata, never full source code.**

The existing `verifyEmbeddingText()` security check must be applied to all text sent to Ollama, identical to the current OpenAI path.

## Property 13: ACID Transaction Integrity

**∀ write operation W: W is atomic — either fully committed or fully rolled back.**

LadybugDB's serializable ACID transactions must be used for all write operations during indexing.

## Property 14: Search Result Type Consistency

**∀ SearchResult r: r.symbolId is non-empty ∧ r.score ∈ [0.0, 1.0] ∧ r.metadata is a valid Record.**

The `SearchResult` type contract must be preserved regardless of the underlying database engine.
