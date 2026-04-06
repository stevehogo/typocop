# Requirements Document

## Introduction

The embeddings pipeline feature wires up the real OpenAI embedding function, persists embeddings to pgvector via `indexSymbol`, degrades gracefully when `OPENAI_API_KEY` is absent, and surfaces an `embeddingCount` in CLI statistics output. It replaces a stub `embedFn` that always returned `null` and fixes `indexSymbol` being imported but never called.

## Glossary

- **EmbeddingPipeline**: The Phase 6 logic inside `runIndexingPipeline` responsible for generating and storing embeddings
- **SearchIndexBuilder**: The `buildSearchIndex` function in `search/index.ts`
- **PipelineOrchestrator**: The `runIndexingPipeline` function in `pipeline.ts`
- **CLI**: The `executeIndexingPipeline` function in `executor.ts` and its statistics output
- **EmbeddingResult**: A pair of `{ symbolId: string, embedding: Embedding }` returned by `buildSearchIndex`
- **embedFn**: A function `(text: string) => Promise<Embedding | null>`, or `null` when embeddings are disabled
- **indexSymbol**: The function in `vector/index-store.ts` that upserts an embedding vector into pgvector

---

## Requirements

### Requirement 1: Real Embedding Function Construction

**User Story:** As a developer, I want the pipeline to use the real OpenAI embedding function when an API key is configured, so that symbol clusters are embedded and stored for semantic search.

#### Acceptance Criteria

1. WHEN `OPENAI_API_KEY` is present in the environment, THE EmbeddingPipeline SHALL construct `embedFn` using `embedText()` with model `text-embedding-3-large` and dimensions `1536`
2. WHEN `OPENAI_API_KEY` is absent or empty, THE EmbeddingPipeline SHALL set `embedFn` to `null` and log the warning `[pipeline] OPENAI_API_KEY not set — skipping embedding generation` exactly once
3. WHEN `OPENAI_API_KEY` is absent, THE EmbeddingPipeline SHALL return `embeddingCount` of `0` in `PipelineResult`

---

### Requirement 2: Search Index Returns Embeddings

**User Story:** As a developer, I want `buildSearchIndex` to return collected embeddings instead of discarding them, so that the pipeline can persist them to pgvector.

#### Acceptance Criteria

1. THE SearchIndexBuilder SHALL return a `SearchIndex` containing an `embeddings: EmbeddingResult[]` field
2. WHEN `embedFn` is non-null, THE SearchIndexBuilder SHALL invoke `embedFn` for each cluster and include each non-null result in `SearchIndex.embeddings`
3. WHEN `embedFn` is `null`, THE SearchIndexBuilder SHALL return `embeddings` as an empty array
4. THE SearchIndexBuilder SHALL set each `EmbeddingResult.symbolId` to the first symbol ID in the corresponding cluster (`cluster.symbols[0]`)
5. THE SearchIndexBuilder SHALL set `SearchIndex.symbolCount` equal to the length of the `symbols` input array

---

### Requirement 3: Embedding Persistence to pgvector

**User Story:** As a developer, I want each generated embedding to be persisted to pgvector, so that semantic search queries can retrieve relevant symbols.

#### Acceptance Criteria

1. WHEN `SearchIndex.embeddings` is non-empty, THE PipelineOrchestrator SHALL call `indexSymbol` exactly once per `EmbeddingResult`
2. WHEN an OpenAI API call fails for a cluster, THE PipelineOrchestrator SHALL skip that cluster and continue processing remaining clusters
3. IF `indexSymbol` throws, THEN THE PipelineOrchestrator SHALL propagate the error and halt the pipeline
4. THE PipelineOrchestrator SHALL set `PipelineResult.embeddingCount` to the number of embeddings successfully stored

---

### Requirement 4: CLI Statistics Surface Embedding Count

**User Story:** As a developer running the indexer, I want to see how many embeddings were generated in the statistics output, so that I can verify the embedding pipeline ran correctly.

#### Acceptance Criteria

1. THE CLI SHALL include an `embeddingCount` field in `IndexingStats`
2. THE CLI SHALL display `Embeddings: N` in the statistics block after pipeline execution

---

### Requirement 5: Security — API Key and Data Handling

**User Story:** As a security-conscious operator, I want the pipeline to handle the API key and source data safely, so that secrets and proprietary code are not leaked.

#### Acceptance Criteria

1. THE EmbeddingPipeline SHALL read `OPENAI_API_KEY` exclusively from `process.env` and SHALL NOT log or transmit the key value
2. THE EmbeddingPipeline SHALL only send cluster metadata text (names, categories, symbol signatures) to the OpenAI API, not raw source file content
