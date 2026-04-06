# Algorithms & Data Models — MCP Natural Language Search

Part of the [MCP Natural Language Search Design](./design.md).

## Data Models

### Input

```typescript
interface SmartSearchParams {
  query: string;       // natural language, non-empty, sanitized before use
  maxResults?: number; // default 10, capped at 50
}
```

Output reuses the existing `MCPToolResponse` from `src/types/index.ts` — no new types needed.

## Key Functions with Formal Specifications

### `sanitizeQuery(query: string): string`

**Preconditions:** `query` is any string (may be empty or contain special characters)

**Postconditions:**
- Cypher injection patterns removed: `;`, `'`, `"`, `\`, and keywords `MATCH`, `CREATE`, `DELETE`, `SET`, `REMOVE` (case-insensitive)
- Result is trimmed
- Safe input is returned unchanged (modulo trim)

### `executeSmartSearchTool(...): Promise<MCPToolResponse>`

**Preconditions:**
- `params.query` is non-empty after sanitization
- `pool` is a connected `pg.Pool` with the `embeddings` table populated
- `driver` is a connected Neo4j `Driver`

**Postconditions:**
- `response.summary` is a non-empty string
- `response.confidence` ∈ [0.0, 1.0]
- `response.symbols.length <= maxResults`
- All returned symbol IDs correspond to pgvector hits
- If pgvector returns 0 results → `symbols` is empty, `confidence = 0.5`

## Algorithmic Pseudocode

```pascal
PROCEDURE executeSmartSearchTool(params, pool, driver, sessionManager)
  INPUT: params (query, maxResults?), pool, driver, sessionManager
  OUTPUT: MCPToolResponse

  SEQUENCE
    raw ← params.query AS string
    IF raw IS NULL OR raw.trim() = "" THEN
      THROW Error("query is required")
    END IF
    sanitized ← sanitizeQuery(raw)
    limit ← MIN(params.maxResults ?? 10, 50)

    embedding ← generateEmbedding(sanitized)
    searchResults ← semanticSearch(pool, embedding, limit * 2)

    IF searchResults.length = 0 THEN
      RETURN emptyResponse(sanitized)
    END IF

    session ← sessionManager.acquire(driver)
    TRY
      resolved ← session.executeRead(tx →
        FOR each sr IN searchResults DO
          node ← txFindNode(tx, sr.symbolId)
          IF node IS NOT NULL THEN COLLECT (node, sr.score) END IF
        END FOR
      )
      topId    ← resolved[0].node.id
      clusters ← txFindClustersBySymbol(tx, topId)
    FINALLY
      sessionManager.release(session)
    END TRY

    confidence ← computeConfidence(resolved, searchResults[0].score)
    summary    ← buildSummary(sanitized, resolved, clusters)

    RETURN MCPToolResponse {
      symbols:      resolved.slice(0, limit).map(toMCPSymbol),
      clusters:     clusters.map(toMCPCluster),
      processes:    [],
      confidence,
      riskLevel:    "low",
      affectedFlows: [],
      summary,
    }
  END SEQUENCE
END PROCEDURE
```

```pascal
PROCEDURE computeConfidence(resolved, topScore)
  INPUT: resolved[], topScore ∈ [0,1]
  OUTPUT: confidence ∈ [0,1]

  IF resolved.length = 0 THEN RETURN 0.5 END IF
  resolutionRate ← resolved.length / searchResults.length
  confidence ← topScore * 0.6 + resolutionRate * 0.4
  RETURN CLAMP(confidence, 0.5, 0.99)
END PROCEDURE
```

## Example Usage

```typescript
// AI asks: "what will be the effect of changing ip based limitation?"
const response = await callTool("smart_search", {
  query: "ip based rate limiting",
  maxResults: 5,
});
// response.summary:
// "Found 3 symbols matching 'ip based rate limiting' (top score: 0.87):
//  IpRateLimitGuard, checkIpLimit, IpLimitConfig."

// Feed top result into impact_analysis:
const impact = await callTool("impact_analysis", {
  symbolName: response.symbols[0].name,  // "IpRateLimitGuard"
  changeType: "modify",
});
```
