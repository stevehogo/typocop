# Tasks: MCP Natural Language Search

## Task List

- [x] 1. Implement `src/mcp/smart-search-tool.ts`
  _Skills: `typescript-expert`, `vector-database-engineer`, `error-handling-patterns`, `clean-code`
  - [x] 1.1 Export `sanitizeQuery(query: string): string` — strips `;`, `'`, `"`, `\`, and Cypher keywords via regex
  - [x] 1.2 Export `executeSmartSearchTool(params, vectorPool, driver, sessionManager): Promise<MCPToolResponse>` — validates input, embeds, searches pgvector, resolves symbols in Neo4j, returns MCPToolResponse
  - [x] 1.3 Implement `computeConfidence(resolved, topScore): number` — weighted formula clamped to [0.5, 0.99]; returns 0.5 when resolved is empty
  - [x] 1.4 Implement `buildSummary(query, resolved, clusters): string` — returns non-empty human-readable string always

- [x] 2. Register `smart_search` in `src/mcp/registration.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [x] 2.1 Add `smart_search` entry to `TOOL_DEFINITIONS` with `query` (required) and `maxResults` (optional) schema

- [x] 3. Wire `smart_search` into `src/mcp/tools.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [x] 3.1 Add `case "smart_search"` to `executeTool` switch, delegating to `executeSmartSearchTool`

- [x] 4. Write unit tests — `src/mcp/smart-search-tool.test.ts`
  _Skills: `testing-patterns`, `tdd-workflow`, `typescript-expert`
  - [x] 4.1 `sanitizeQuery` removes all injection patterns and trims whitespace
  - [x] 4.2 `executeSmartSearchTool` with mocked deps returns valid MCPToolResponse with non-empty summary
  - [x] 4.3 Empty / whitespace-only query throws `Error("query is required")`
  - [x] 4.4 Zero pgvector results → `symbols: []`, `confidence: 0.5`
  - [x] 4.5 `maxResults` cap: passing 100 returns at most 50 symbols

- [x] 5. Write property-based tests — `src/mcp/smart-search-tool.test.ts`
  _Skills: `testing-patterns`
  - [x] 5.1 P2: `computeConfidence` always returns value in [0.0, 1.0] for any inputs
  - [x] 5.2 P3: `sanitizeQuery` is idempotent — `sanitizeQuery(sanitizeQuery(s)) === sanitizeQuery(s)` for any string
  - [x] 5.3 P6: `response.symbols.length <= maxResults` for any `maxResults` in [1, 50]

- [x] 6. Extend integration tests — `tests/integration/mcp-integration.test.ts`
  _Skills: `testing-patterns`
  - [x] 6.1 `tools/list` response includes `smart_search`
  - [x] 6.2 `smart_search { query: "ip rate limiting" }` against live pgvector returns `symbols.length > 0` and `confidence >= 0.5`
  - [x] 6.3 Existing tools still return valid MCPToolResponse (non-regression)
