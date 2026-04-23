# Design: Testing Strategy

## Unit Testing Approach

All adapter implementations are unit-tested with mocked LadybugDB and Ollama dependencies.

**Key test files:**
- `src/db/ladybug-graph-adapter.test.ts` — GraphAdapter CRUD, prefix isolation, Cypher execution
- `src/db/ladybug-vector-adapter.test.ts` — VectorAdapter indexing, search, threshold filtering
- `src/db/ollama-embedding-adapter.test.ts` — Ollama HTTP calls, error handling, dimension validation
- `src/db/noop-embedding-adapter.test.ts` — NoOp always returns null, isEnabled() returns false
- `src/config/configuration-manager.test.ts` — Extended config loading, Ollama/LadybugDB validation

**Mocking strategy:**
- Mock LadybugDB driver/session for graph adapter tests
- Mock `fetch` for Ollama adapter tests
- Mock LadybugDB `db.sql()` for vector adapter tests

## Property-Based Testing Approach

**Property Test Library**: `fast-check`

**Properties to test:**

| Property | Test File | Validates |
|---|---|---|
| Prefix isolation | `ladybug-graph-adapter.test.ts` | Property 2 |
| Search score ordering | `ladybug-vector-adapter.test.ts` | Property 3 |
| Search threshold | `ladybug-vector-adapter.test.ts` | Property 4 |
| Embedding dimensions | `ollama-embedding-adapter.test.ts` | Property 5 |
| Ollama disabled default | `noop-embedding-adapter.test.ts` | Property 6 |
| Config validation | `configuration-manager.test.ts` | Property 8 |
| SearchResult type | `ladybug-vector-adapter.test.ts` | Property 14 |

**Arbitraries needed:**
- `embeddingArbitrary(dims: number)` — generates valid Embedding with specified dimensions
- `searchResultArbitrary()` — generates valid SearchResult with score in [0, 1]
- `ollamaConfigArbitrary()` — generates valid/invalid OllamaConfig combinations
- `prefixArbitrary()` — generates valid prefix strings

## Integration Testing Approach

Integration tests verify the full adapter stack against a real LadybugDB instance (file-based, no external services needed).

**Test scenarios:**
1. Full indexing pipeline writes to LadybugDB and reads back correctly
2. All five query types produce results through the adapter layer
3. Prefix isolation: two prefixes in same DB don't interfere
4. Ollama enabled: embeddings stored and searchable (requires Ollama running)
5. Ollama disabled: all graph queries work, smart search returns empty
6. Connection retry: adapter recovers from transient file lock

**Test location:** `tests/integration/ladybugdb-migration.test.ts`

## Performance Considerations

- LadybugDB is embedded (in-process), so connection overhead is near-zero
- Vector search should be benchmarked against current pgvector: target ≤ current latency
- Graph queries should be benchmarked against Neo4j: target ≤ current latency
- Ollama embedding generation is local, latency depends on model size and hardware

## Security Considerations

- LadybugDB file permissions should be restricted (0600)
- Ollama runs locally — no API keys transmitted over network
- All existing security checks (input sanitization, path validation, privacy verification) are preserved through the adapter layer
- No credentials stored in LadybugDB config (file-based, no auth needed)
