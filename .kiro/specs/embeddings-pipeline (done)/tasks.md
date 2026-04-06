# Implementation Plan: Embeddings Pipeline

## Overview

Wire up the real OpenAI embedding function in `pipeline.ts`, return `EmbeddingResult[]` from `buildSearchIndex`, call `indexSymbol` per result, and surface `embeddingCount` in the CLI stats output. Graceful degradation when `OPENAI_API_KEY` is absent.

## Tasks

- [x] 1. Update `SearchIndex` type and `buildSearchIndex` return value in `search/index.ts`
  _Skills: `typescript-expert`, `clean-code`
  - Add `EmbeddingResult` interface (`symbolId: string`, `embedding: Embedding`) local to `search/index.ts`
  - Add `embeddings: EmbeddingResult[]` field to `SearchIndex` interface
  - Change `embedFn` parameter type to `((text: string) => Promise<Embedding | null>) | null`
  - Collect non-null embedding results paired with `cluster.symbols[0]` as representative ID
  - Return `embeddings: collected` in the `SearchIndex` result (empty array when `embedFn` is null)
  - Update existing `buildSearchIndex` tests in `index.test.ts` to assert `index.embeddings` shape
  - _Requirements: 8.3, 3.6_

- [x] 2. Replace stub `embedFn` and call `indexSymbol` in `pipeline.ts`
  _Skills: `typescript-expert`, `error-handling-patterns`, `nodejs-best-practices`
  - Add `embeddingCount: number` to `PipelineResult` interface
  - Read `OPENAI_API_KEY` from `process.env` at the start of Phase 6
  - If key absent: log `[pipeline] OPENAI_API_KEY not set — skipping embedding generation` once and set `embeddingCount = 0`
  - If key present: construct real `embedFn` using `embedText` from `search/embed.ts` with `{ apiKey, model: "text-embedding-3-large", dimensions: 1536 }`
  - Pass `embedFn` (or `null`) to `buildSearchIndex`
  - Iterate `searchIndex.embeddings` and call `indexSymbol(vectorPool, result.symbolId, result.embedding, {})` for each — DB errors propagate
  - Return `embeddingCount` in `PipelineResult`
  - _Requirements: 3.6, 3.8, 8.3_

  - [ ]* 2.1 Write unit tests for graceful degradation (no API key path)
    - Mock `process.env.OPENAI_API_KEY` as absent; assert `embeddingCount === 0` and `indexSymbol` not called
    - Mock key present; assert `indexSymbol` called once per non-null embedding result
    - Assert DB errors from `indexSymbol` propagate (hard error)
    - _Requirements: 3.6_

- [x] 3. Add `embeddingCount` to `IndexingStats` and surface it in `executor.ts`
  _Skills: `typescript-expert`, `clean-code`
  - Add `embeddingCount: number` to `IndexingStats` interface
  - Map `result.embeddingCount` into the returned `IndexingStats` object in `executeIndexingPipeline`
  - Print `  Embeddings:    ${chalk.cyan(stats.embeddingCount)}` in the statistics block (always shown)
  - _Requirements: 1.6_

- [x] 4. Checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Write property-based test for embedding dimensionality (Property 14)
  _Skills: `testing-patterns`, `tdd-workflow`
  - In `src/indexer/search/index.test.ts`, extend the existing Property 14 suite
  - Add a test asserting that `buildSearchIndex` collects only embeddings where `vector.length === 1536 && dimensions === 1536` using `fc.asyncProperty` with `symbolArbitrary()` and `clusterArbitrary()`
  - Mock `embedFn` to return an `embeddingArbitrary()` result; assert every entry in `index.embeddings` satisfies the dimensionality invariant
  - **Property 14: Embedding Dimensionality**
  - **Validates: Requirements 8.3**
  - _Requirements: 8.3_

- [x] 6. Final checkpoint — ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
