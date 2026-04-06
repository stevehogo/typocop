# Correctness, Testing & Operations — MCP Natural Language Search

Part of the [MCP Natural Language Search Design](./design.md).

## Correctness Properties

**P1 — Scores in [0,1] and descending**: For any two consecutive results `r[i]`, `r[i+1]`: `r[i].score >= r[i+1].score` and `r[i].score ∈ [0.0, 1.0]`.

**P2 — Confidence in [0,1]**: For any input, `response.confidence ∈ [0.0, 1.0]`.

**P3 — Sanitization removes injection patterns**: For any string containing `;`, `'`, `"`, `\`, or Cypher keywords, `sanitizeQuery(s)` contains none of those.

**P4 — Zero results → empty response**: When pgvector returns 0 results, `response.symbols.length === 0` and `response.confidence === 0.5`.

**P5 — Summary always non-empty**: For any valid params, `response.summary.length > 0`.

**P6 — Result count bounded**: For any `maxResults = n`, `response.symbols.length <= n`.

## Error Handling

| Scenario | Response |
|---|---|
| Empty / whitespace-only query | Throw `Error("query is required")` → MCP returns `isError: true` |
| OpenAI API unavailable | Propagate `Error("Failed to generate embedding: service unavailable")` |
| pgvector returns 0 results | Empty `MCPToolResponse`, `confidence: 0.5`, descriptive summary |
| Neo4j symbol not found for a `symbolId` | Skip silently, continue resolving remaining IDs |
| All symbols unresolvable | Empty symbols, `confidence: 0.5` |

## Testing Strategy

### Unit Tests — `src/mcp/smart-search-tool.test.ts`

- `sanitizeQuery` removes `;`, `'`, `"`, `\`, and Cypher keywords
- `executeSmartSearchTool` with mocked `generateEmbedding` + `semanticSearch` + Neo4j session
- Empty query throws
- 0 pgvector results → empty response with `confidence: 0.5`
- `summary` is always present and non-empty

### Property-Based Tests (fast-check)

```typescript
// P2: confidence always in [0,1]
fc.assert(fc.property(
  fc.array(fc.record({ symbolId: fc.string(), score: fc.float({ min: 0, max: 1 }) })),
  (results) => {
    const conf = computeConfidence(results, results[0]?.score ?? 0);
    return conf >= 0.0 && conf <= 1.0;
  }
));

// P3: sanitizeQuery idempotent on clean strings
fc.assert(fc.property(
  fc.string().filter(s => !/[;'"\\]/.test(s)),
  (s) => sanitizeQuery(s) === sanitizeQuery(sanitizeQuery(s))
));

// P6: result count ≤ maxResults
fc.assert(fc.property(
  fc.integer({ min: 1, max: 50 }),
  async (n) => {
    const resp = await executeSmartSearchTool(
      { query: "test", maxResults: n }, mockPool, mockDriver, mockMgr
    );
    return resp.symbols.length <= n;
  }
));
```

**Property Test Library**: `fast-check`

### Integration Tests — `tests/integration/mcp-integration.test.ts`

- `smart_search "ip rate limiting"` against live pgvector → `symbols.length > 0`
- `response.summary` contains the query text
- `response.confidence >= 0.5`
- `tools/list` includes `smart_search`

## Security Considerations

- All query strings pass through `sanitizeQuery` before embedding or any DB call (Req 22.3)
- Only the sanitized query text is sent to OpenAI — no source code, no file paths (Req 22.2)
- `maxResults` is capped at 50 to prevent resource exhaustion

## Performance Considerations

- Embedding generation: ~200ms (OpenAI network call)
- pgvector HNSW cosine search on 318 rows: <5ms
- Neo4j symbol resolution in one read tx: <50ms
- Total expected latency: ~300ms — within the 500ms simple query target
