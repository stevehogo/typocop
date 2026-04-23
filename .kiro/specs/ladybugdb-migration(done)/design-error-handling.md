# Design: Error Handling

## Error Scenario 1: LadybugDB Connection Failure

**Condition**: LadybugDB file is locked, corrupted, or path is not writable.
**Response**: Retry up to 3 times with exponential backoff (200ms, 400ms, 800ms). Log each attempt.
**Recovery**: If all retries fail, throw `DatabaseConnectionError` with the path and underlying cause. The CLI/MCP server surfaces this as a startup failure with actionable message.

```typescript
class DatabaseConnectionError extends Error {
  constructor(
    public readonly dbPath: string,
    public readonly cause: unknown,
  ) {
    super(`Failed to connect to LadybugDB at ${dbPath}`);
  }
}
```

## Error Scenario 2: Ollama Service Unavailable

**Condition**: Ollama is enabled but the HTTP endpoint is unreachable or returns errors.
**Response**: `OllamaEmbeddingAdapter.embedText()` returns `null`. Log a warning with the URL and error.
**Recovery**: The system continues without embeddings. Smart search degrades to returning empty results. All graph-based queries (impact analysis, context retrieval, data flow trace) are unaffected. During indexing, Phase 6 skips embedding generation and logs a summary warning.

## Error Scenario 3: Ollama Dimension Mismatch

**Condition**: Ollama returns an embedding with dimensions different from `OLLAMA_DIMENSIONS` config.
**Response**: Log a warning with expected vs actual dimensions. Return `null` from `embedText()`.
**Recovery**: Same as Ollama unavailable — graceful degradation. This protects against model changes.

## Error Scenario 4: LadybugDB Cypher Transpilation Failure

**Condition**: A Cypher query uses syntax not supported by LadybugDB's auto-transpiler.
**Response**: LadybugDB throws an error. The adapter catches it and wraps in a typed `CypherTranspilationError`.
**Recovery**: Log the failing query (without parameters to avoid data leaks). Surface to caller as a query execution failure. This should be caught during integration testing.

## Error Scenario 5: Embedding Table Schema Mismatch

**Condition**: Existing embeddings table has different dimensions than current config (e.g., switched Ollama models).
**Response**: Log a warning about dimension mismatch. Drop and recreate the embeddings table.
**Recovery**: Re-indexing is required after a dimension change. The CLI should surface this clearly.

## Error Scenario 6: File System Permissions

**Condition**: LadybugDB path is not writable (e.g., read-only filesystem, permissions issue).
**Response**: Connection attempt fails immediately (no retry for permission errors).
**Recovery**: Throw `DatabaseConnectionError` with clear message about path permissions.
