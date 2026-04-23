# Implementation Plan: HuggingFace Embeddings

## Overview

Add a HuggingFace Transformers.js embedding adapter to Typocop, with provider-based configuration, privacy registration, and resource cleanup. All code is TypeScript; tests use vitest + fast-check.

## Tasks

- [x] 1. Install dependency and extend configuration types
  _Skills: `typescript-expert`, `architecture`
  - [x] 1.1 Run `pnpm add @huggingface/transformers` to install the package
  - [x] 1.2 Add `EmbeddingProvider`, `HuggingFaceConfig`, and `EmbeddingConfig` interfaces to `src/config/types.ts`
  - [x] 1.3 Add `embedding: EmbeddingConfig` field to `FullConfig`
  - _Requirements: 4.1, 4.3, 4.6_

- [x] 2. Update ConfigurationManager to load embedding config
  _Skills: `typescript-expert`, `error-handling-patterns`
  - [x] 2.1 Add `loadEmbeddingConfig()` to `src/config/configuration-manager.ts` parsing `EMBEDDING_PROVIDER`, `HF_MODEL`, `HF_DTYPE`, `HF_DIMENSIONS`, `HF_POOLING` with defaults
  - [x] 2.2 Implement backward compatibility: when `EMBEDDING_PROVIDER` is unset, derive provider from `OLLAMA_ENABLED`
  - [x] 2.3 Validate `HF_DTYPE` ∈ {fp32, fp16, q8}, `HF_DIMENSIONS` is positive integer, throw on invalid
  - [x] 2.4 Wire `loadEmbeddingConfig()` into the existing config loading flow so `FullConfig.embedding` is populated
  - [x] 2.5 Update Ollama defaults in `OLLAMA_DEFAULTS` and `OllamaConfig` doc comments: model `mxbai-embed-large`, dimensions `1024`
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3_

- [x] 3. Implement HuggingFaceEmbeddingAdapter
  _Skills: `typescript-expert`, `error-handling-patterns`, `nodejs-best-practices`
  - [x] 3.1 Create `src/db/huggingface-embedding-adapter.ts` implementing `EmbeddingAdapter`
  - [x] 3.2 Implement lazy `ensurePipeline()` with shared init promise and retry-on-failure reset
  - [x] 3.3 Implement `embedText()`: call `verifyEmbeddingText()` first, run pipeline, validate dimensions, return `null` on error
  - [x] 3.4 Implement `isEnabled()` → `true`, `getDimensions()` → `config.dimensions`, `dispose()` for ONNX cleanup
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 7.1, 7.2_

- [x] 4. Update factory and privacy module
  _Skills: `typescript-expert`, `architecture`, `security-audit`
  - [x] 4.1 Update `LadybugDatabaseAdapter.initialize()` in `src/db/database-adapter.ts` to use provider-based switch (`huggingface` | `ollama` | `none`)
  - [x] 4.2 Add `"huggingface-embeddings"` to `ExternalDataPolicy.service` union and `EXTERNAL_DATA_POLICIES` array in `src/security/privacy.ts`
  - [x] 4.3 Update `.env.example` with `EMBEDDING_PROVIDER`, `HF_MODEL`, `HF_DTYPE`, `HF_DIMENSIONS`, `HF_POOLING` variables
  - _Requirements: 3.3, 6.1, 6.2, 6.3, 6.4_

- [x] 5. Checkpoint — verify compilation and existing tests
  - Ensure `pnpm build` succeeds and `pnpm test --run` passes. Ask the user if questions arise.

- [x] 6. Write unit tests for adapter and configuration
  _Skills: `testing-patterns`, `typescript-expert`
  - [x] 6.1 Create `src/db/huggingface-embedding-adapter.test.ts` — mock `@huggingface/transformers` pipeline; test `embedText` returns correct shape, returns `null` on error, calls `verifyEmbeddingText` before inference, concurrent init deduplication, `dispose()` cleanup, `isEnabled`/`getDimensions`
  - [x] 6.2 Add config loading tests in `src/config/configuration-manager.test.ts` — test env var parsing, defaults, backward compat, validation errors for invalid dtype/dimensions/provider
  - [x] 6.3 Add factory selection tests in `src/db/database-adapter.test.ts` — test provider switch creates correct adapter type
  - _Requirements: 1.1–1.6, 2.1–2.4, 4.1–4.6, 5.1–5.3, 6.1–6.4_

- [ ] 7. Write property-based tests
  _Skills: `testing-patterns`, `vector-database-engineer`
  - [ ]* 7.1 **Property 1: Dimension Consistency** — for any non-null result, `vector.length === dimensions === config.dimensions`
    - **Validates: Requirements 1.3, 1.4**
  - [ ]* 7.2 **Property 2: Null Safety** — for any string input (empty, long, unicode), `embedText` returns `Embedding | null`, never throws (except privacy)
    - **Validates: Requirements 1.5, 1.6**
  - [ ]* 7.3 **Property 3: Concurrent Initialization Safety** — for N concurrent calls, pipeline factory invoked exactly once
    - **Validates: Requirement 2.3**
  - [ ]* 7.4 **Property 4: Privacy Invariant** — `verifyEmbeddingText` called before any inference; privacy exceptions propagate
    - **Validates: Requirements 3.1, 3.2**
  - [ ]* 7.5 **Property 5: Configuration Validation** — invalid provider/dtype/dimensions always throws
    - **Validates: Requirements 4.2, 4.4, 4.5**
  - [ ]* 7.6 **Property 6: Explicit Provider Override** — when `EMBEDDING_PROVIDER` is set, `OLLAMA_ENABLED` is ignored
    - **Validates: Requirement 5.3**
  - [ ]* 7.7 **Property 7: Provider Exclusivity** — for any valid provider, exactly one adapter type is instantiated
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

- [x] 8. Final checkpoint — full test suite
  - Ensure all tests pass with `pnpm test --run`. Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property tests use `fast-check` and validate correctness properties from the design document
- All adapter code follows the existing null-return error convention (see `OllamaEmbeddingAdapter`)
- The `@huggingface/transformers` pipeline is mocked in unit tests to avoid model downloads
