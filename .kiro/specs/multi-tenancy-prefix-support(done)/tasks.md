# Implementation Plan: Multi-Tenancy Prefix Support

- [x] 1. Write Neo4j bug condition exploration test
  _Skills: `testing-patterns`, `typescript-expert`
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - Simulate two instances with different prefixes (`tpc_`, `myapp_`) writing to the same Neo4j database
  - Index a symbol from instance 1, index same symbol ID from instance 2 with different properties
  - Verify instance 1 reads instance 2's node (demonstrates label collision)
  - Document counterexamples: both instances write to unprefixed `Symbol` label
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write PostgreSQL bug condition exploration test
  _Skills: `testing-patterns`, `vector-database-engineer`, `postgresql`
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - Simulate two instances with different prefixes sharing the same PostgreSQL database
  - Index embedding for symbol `foo` from instance 1, then from instance 2 with a different vector
  - Verify instance 1 retrieves instance 2's embedding (demonstrates table collision)
  - Document counterexamples: both instances write to unprefixed `embeddings` table
  - _Requirements: 1.4, 1.5, 1.6_

- [x] 3. Write preservation property tests (BEFORE implementing fix)
  _Skills: `testing-patterns`, `vector-database-engineer`, `postgresql`
  - Observe single-instance behavior on UNFIXED code (prefix `tpc_`)
  - Write PBT: Neo4j node writes and reads produce identical results before and after fix
  - Write PBT: PostgreSQL semantic search returns identical results before and after fix
  - **EXPECTED OUTCOME**: Tests PASS on unfixed code (confirms baseline to preserve)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 4. Fix Neo4j: add prefix to storeNodes and storeEdges
  _Skills: `typescript-expert`, `clean-code`
  - [x] 4.1 Update `storeNodes(session, nodes, prefix)` in `src/graph/store.ts`
    - Add `prefix: string` parameter
    - Prepend prefix to each node label: `n.labels.map(l => \`${prefix}${l}\`)`
    - _Requirements: 2.1_
  - [x] 4.2 Update `storeEdges(session, edges, prefix)` in `src/graph/store.ts`
    - Add `prefix: string` parameter
    - Prepend prefix to relationship type: `` `${prefix}${edge.relType}` ``
    - _Requirements: 2.2_
  - [x] 4.3 Update `src/indexer/pipeline.ts` to pass `configurationManager.getPrefix()` to both functions
    - _Requirements: 2.1, 2.2_

- [x] 5. Fix PostgreSQL: add prefix to vector store functions
  _Skills: `typescript-expert`, `postgresql`, `vector-database-engineer`
  - [x] 5.1 Update `initVectorStore(pool, prefix)` in `src/vector/connection.ts`
    - Add `prefix: string` parameter
    - Use `` `${prefix}embeddings` `` for table name and `` `${prefix}embeddings_hnsw_idx` `` for index name
    - _Requirements: 2.6_
  - [x] 5.2 Update `semanticSearch(pool, embedding, limit, prefix)` in `src/vector/search.ts`
    - Add `prefix: string` parameter
    - Replace hardcoded `embeddings` with `` `${prefix}embeddings` `` in FROM clause
    - _Requirements: 2.4_
  - [x] 5.3 Update `indexSymbol(pool, symbolId, embedding, metadata, prefix)` in `src/vector/index-store.ts`
    - Add `prefix: string` parameter
    - Replace hardcoded `embeddings` with `` `${prefix}embeddings` `` in INSERT statement
    - _Requirements: 2.5_

- [x] 6. Update all callers to pass prefix
  _Skills: `typescript-expert`, `architecture`
  - [x] 6.1 Update `src/indexer/pipeline.ts` — pass `configurationManager.getPrefix()` to `initVectorStore` and `indexSymbol`
  - [x] 6.2 Update `src/query/server.ts` — pass prefix to `semanticSearch`
  - [x] 6.3 Identify any remaining callers using grep/typocop and update them
  - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.6_

- [x] 7. Verify bug condition exploration tests now pass
  _Skills: `testing-patterns`
  - Re-run Neo4j exploration test from task 1 — **EXPECTED OUTCOME**: PASSES
  - Re-run PostgreSQL exploration test from task 2 — **EXPECTED OUTCOME**: PASSES
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 8. Verify preservation tests still pass
  _Skills: `testing-patterns`
  - Re-run preservation tests from task 3 — **EXPECTED OUTCOME**: PASSES (no regressions)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 9. Checkpoint — full test suite
  _Skills: `testing-patterns`
  - Run full test suite and confirm no regressions
  - Verify all callers have been updated with prefix parameter
