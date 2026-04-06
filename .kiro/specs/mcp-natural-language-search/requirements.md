# Requirements: MCP Natural Language Search

## Requirement 1: smart_search MCP Tool

**User Story**: As an AI editor, I want to query the code graph using natural language so that I don't need to know exact symbol names.

### Acceptance Criteria

1.1 The MCP server MUST expose a `smart_search` tool that accepts a `query` string and optional `maxResults` integer.

1.2 Given a natural language query (e.g. "ip based rate limiting"), the tool MUST return a `MCPToolResponse` with `symbols`, `clusters`, `confidence`, and a non-empty `summary`.

1.3 The tool MUST sanitize the query string before embedding or executing any database query, removing Cypher injection patterns (`;`, `'`, `"`, `\`, and keywords `MATCH`, `CREATE`, `DELETE`, `SET`, `REMOVE`).

1.4 The tool MUST generate a 1536-dim embedding via `generateEmbedding` and perform cosine similarity search against the `embeddings` pgvector table.

1.5 The tool MUST resolve the top-k pgvector `symbolId` results to full symbol nodes via Neo4j `txFindNode` within a single `session.executeRead` transaction.

1.6 The tool MUST return `confidence: 0.5` and an empty `symbols` array when pgvector returns zero results.

1.7 `maxResults` MUST default to 10 and be capped at 50.

1.8 The tool MUST appear in the `tools/list` response alongside the four existing tools.

## Requirement 2: Confidence Scoring

**User Story**: As an AI editor, I want a confidence score so I can judge how reliable the search results are.

### Acceptance Criteria

2.1 `confidence` MUST always be in the range [0.0, 1.0].

2.2 When at least one symbol is resolved, `confidence` MUST be computed as a weighted combination of the top cosine similarity score (weight 0.6) and the resolution rate (weight 0.4), clamped to [0.5, 0.99].

2.3 When zero symbols are resolved, `confidence` MUST be exactly 0.5.

## Requirement 3: Non-Regression

**User Story**: As a developer, I want the existing MCP tools to continue working unchanged after this feature is added.

### Acceptance Criteria

3.1 The four existing tools (`get_symbol_context`, `find_dependents`, `trace_data_flow`, `impact_analysis`) MUST return identical responses before and after this change.

3.2 No existing source file other than `src/mcp/tools.ts` and `src/mcp/registration.ts` MUST be modified.
