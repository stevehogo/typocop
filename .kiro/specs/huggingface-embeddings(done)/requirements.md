# Requirements Document

**Related documents:**
- [Design Document](./design.md)

## Introduction

This document specifies requirements for adding a HuggingFace Transformers.js embedding adapter to the Typocop code graph analyzer. The adapter runs the `mixedbread-ai/mxbai-embed-large-v1` model in-process via ONNX Runtime, replacing the need for an external Ollama server. A provider-based configuration model enables clean selection between embedding backends while maintaining backward compatibility.

## Glossary

- **Embedding_Adapter**: Interface abstracting embedding generation (`isEnabled`, `embedText`, `getDimensions`)
- **HuggingFace_Adapter**: The new `HuggingFaceEmbeddingAdapter` class implementing `Embedding_Adapter`
- **Pipeline**: The `@huggingface/transformers` feature-extraction pipeline for ONNX inference
- **Provider**: One of `"huggingface"`, `"ollama"`, or `"none"` — selects the active embedding backend
- **Configuration_Manager**: The module that loads and validates environment variables into `FullConfig`
- **Privacy_Module**: The `src/security/privacy.ts` module enforcing data protection policies
- **LadybugDatabase_Adapter**: The `LadybugDatabaseAdapter` facade that wires graph, vector, and embedding adapters

## Requirements

### Requirement 1: HuggingFace Adapter Core Behavior

**User Story:** As a developer, I want an in-process embedding adapter using HuggingFace Transformers.js, so that I can generate embeddings without running an external server.

#### Acceptance Criteria

1. THE HuggingFace_Adapter SHALL implement the full Embedding_Adapter interface (`isEnabled`, `embedText`, `getDimensions`)
2. WHEN `isEnabled()` is called, THE HuggingFace_Adapter SHALL return `true`
3. WHEN `getDimensions()` is called, THE HuggingFace_Adapter SHALL return the configured dimensions value
4. WHEN `embedText` is called with valid text, THE HuggingFace_Adapter SHALL return an Embedding with `vector.length` equal to the configured dimensions
5. WHEN `embedText` is called and the Pipeline produces a vector with mismatched dimensions, THE HuggingFace_Adapter SHALL return `null`
6. IF the Pipeline throws an error during inference, THEN THE HuggingFace_Adapter SHALL return `null` without propagating the exception

### Requirement 2: Lazy Pipeline Initialization

**User Story:** As a developer, I want the ONNX pipeline to initialize lazily on first use, so that application startup is not blocked by model loading.

#### Acceptance Criteria

1. WHEN the HuggingFace_Adapter is constructed, THE Pipeline SHALL NOT be initialized
2. WHEN `embedText` is called for the first time, THE HuggingFace_Adapter SHALL initialize the Pipeline before inference
3. WHEN multiple concurrent `embedText` calls occur during initialization, THE HuggingFace_Adapter SHALL share a single Pipeline initialization promise
4. IF Pipeline initialization fails, THEN THE HuggingFace_Adapter SHALL reset the initialization state to allow retry on the next call

### Requirement 3: Privacy Enforcement

**User Story:** As a security-conscious developer, I want the HuggingFace adapter to enforce privacy checks before every inference, so that source code is never processed even though inference is local.

#### Acceptance Criteria

1. WHEN `embedText` is called, THE HuggingFace_Adapter SHALL call `verifyEmbeddingText` before any Pipeline inference
2. IF `verifyEmbeddingText` detects a privacy violation, THEN THE HuggingFace_Adapter SHALL propagate the exception to the caller
3. THE Privacy_Module SHALL include `"huggingface-embeddings"` as a recognized service in the `ExternalDataPolicy` type

### Requirement 4: Provider-Based Configuration

**User Story:** As a developer, I want to select between embedding providers via a single environment variable, so that switching backends is straightforward.

#### Acceptance Criteria

1. THE Configuration_Manager SHALL support an `EMBEDDING_PROVIDER` environment variable with values `"huggingface"`, `"ollama"`, or `"none"`
2. WHEN `EMBEDDING_PROVIDER` is set to an invalid value, THE Configuration_Manager SHALL throw a configuration error
3. THE Configuration_Manager SHALL parse `HF_MODEL`, `HF_DTYPE`, `HF_DIMENSIONS`, and `HF_POOLING` environment variables for HuggingFace settings
4. WHEN `HF_DTYPE` is not one of `"fp32"`, `"fp16"`, or `"q8"`, THE Configuration_Manager SHALL reject the value with an error
5. WHEN `HF_DIMENSIONS` is not a positive integer, THE Configuration_Manager SHALL reject the value with an error
6. WHEN HuggingFace environment variables are not set, THE Configuration_Manager SHALL use defaults: model `mixedbread-ai/mxbai-embed-large-v1`, dtype `fp32`, dimensions `1024`, pooling `cls`

### Requirement 5: Backward Compatibility

**User Story:** As an existing user, I want my current `OLLAMA_ENABLED` configuration to keep working, so that upgrading does not break my setup.

#### Acceptance Criteria

1. WHEN `EMBEDDING_PROVIDER` is not set and `OLLAMA_ENABLED` is `true`, THE Configuration_Manager SHALL default the provider to `"ollama"`
2. WHEN `EMBEDDING_PROVIDER` is not set and `OLLAMA_ENABLED` is not `true`, THE Configuration_Manager SHALL default the provider to `"huggingface"`
3. WHEN `EMBEDDING_PROVIDER` is explicitly set, THE Configuration_Manager SHALL use that value regardless of `OLLAMA_ENABLED`

### Requirement 6: Factory Provider Selection

**User Story:** As a developer, I want the database adapter to instantiate the correct embedding adapter based on the configured provider, so that the system uses the right backend.

#### Acceptance Criteria

1. WHEN the provider is `"huggingface"`, THE LadybugDatabase_Adapter SHALL instantiate a HuggingFace_Adapter
2. WHEN the provider is `"ollama"`, THE LadybugDatabase_Adapter SHALL instantiate an OllamaEmbeddingAdapter
3. WHEN the provider is `"none"`, THE LadybugDatabase_Adapter SHALL instantiate a NoOpEmbeddingAdapter
4. THE LadybugDatabase_Adapter SHALL instantiate exactly one embedding adapter per initialization

### Requirement 7: Resource Cleanup

**User Story:** As a developer, I want to dispose of the HuggingFace adapter cleanly, so that ONNX Runtime resources are released.

#### Acceptance Criteria

1. WHEN `dispose()` is called, THE HuggingFace_Adapter SHALL release the Pipeline and ONNX session resources
2. WHEN `dispose()` is called before the Pipeline was initialized, THE HuggingFace_Adapter SHALL complete without error
