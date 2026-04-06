Part of the [Memgraph + Qdrant Migration](./tasks.md).

# Phase 2: Consumers, Infrastructure & Tests

- [ ] 8. Update consumers to use adapter interfaces
  _Skills: `typescript-expert`, `clean-code`, `nodejs-best-practices`
  - [ ] 8.1 Update `src/cli/executor.ts` — call factories at startup; replace `Driver`/`Pool` params with `graphAdapter`/`vectorAdapter`
    - _Requirements: 6.1, 6.2_
  - [ ] 8.2 Update `src/mcp/server.ts` — same factory pattern as executor.ts
    - _Requirements: 6.1, 6.2_
  - [ ] 8.3 Update `src/indexer/pipeline.ts` — replace `PipelineConfig.vectorPool: Pool` with `vectorAdapter: VectorAdapter`
    - _Requirements: 6.1, 6.2_
  - [ ] 8.4 Update `src/query/smart-search.ts` — accept `VectorAdapter` + `VectorClient` instead of `Pool`
    - _Requirements: 6.1, 6.2_
  - [ ] 8.5 Update `src/mcp/handler.ts` and `src/mcp/tools.ts` — accept `VectorAdapter` + `VectorClient`
    - _Requirements: 6.1, 6.2_

- [ ] 9. Update infrastructure files
  _Skills: `architecture`, `clean-code`
  - [ ] 9.1 Add `memgraph` and `qdrant` services to `docker-compose.yml` with health checks; preserve existing `neo4j` and `pgvector` services unchanged
    - _Requirements: 7.1, 7.2, 7.3_
  - [ ] 9.2 Add `GRAPH_BACKEND`, `VECTOR_BACKEND`, `MEMGRAPH_URI`, `MEMGRAPH_USER`, `MEMGRAPH_PASSWORD`, `QDRANT_URL`, `QDRANT_API_KEY` to `.env.example`
    - _Requirements: 2.1–2.8_

- [ ] 10. Write property-based tests
  _Skills: `testing-patterns`, `vector-database-engineer`
  - [ ]* 10.1 Write property test for Property 1: factory returns correct adapter for every valid backend value
    - **Property 1: Factory returns correct adapter for every valid backend value**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
  - [ ]* 10.2 Write property test for Property 2: factory throws on unrecognized backend string
    - **Property 2: Factory throws on unrecognized backend string**
    - **Validates: Requirements 2.5, 2.6**
  - [ ]* 10.3 Write property test for Property 3: MemgraphAdapter.storeNodes never invokes APOC
    - **Property 3: MemgraphAdapter.storeNodes never invokes APOC**
    - **Validates: Requirements 3.2**
  - [ ]* 10.4 Write property test for Property 4: QdrantAdapter indexSymbol upsert shape is correct
    - **Property 4: QdrantAdapter indexSymbol upsert shape is correct**
    - **Validates: Requirements 4.3**
  - [ ]* 10.5 Write property test for Property 5: QdrantAdapter semanticSearch result mapping round-trip
    - **Property 5: QdrantAdapter semanticSearch result mapping round-trip**
    - **Validates: Requirements 4.4**
  - [ ]* 10.6 Write property test for Property 6: search results are ordered by score descending
    - **Property 6: Search results are ordered by score descending**
    - **Validates: Requirements 4.4**
  - [ ]* 10.7 Write property test for Property 7: indexSymbol then semanticSearch round-trip recovers the symbol
    - **Property 7: indexSymbol then semanticSearch round-trip recovers the symbol**
    - **Validates: Requirements 4.3, 4.4**

- [ ] 11. Write integration tests
  _Skills: `testing-patterns`, `tdd-workflow`, `vector-database-engineer`
  - [ ]* 11.1 Create `tests/integration/memgraph-adapter.test.ts`
    - Bolt connectivity, MERGE idempotency via MemgraphAdapter
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ]* 11.2 Create `tests/integration/qdrant-adapter.test.ts`
    - Collection init, upsert, search round-trip via QdrantAdapter
    - _Requirements: 4.1–4.5_
  - [ ]* 11.3 Create `tests/integration/adapter-factory.test.ts`
    - Factory returns correct adapter for each env var value
    - _Requirements: 2.1–2.8_

- [ ] 12. Final checkpoint — ensure all tests pass
  - Run `pnpm vitest --run` and confirm all existing graph query tests still pass (regression check). Ask the user if questions arise.
  - _Requirements: 8.3_
