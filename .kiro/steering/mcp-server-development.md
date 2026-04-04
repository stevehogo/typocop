---
title: MCP Server Development
inclusion: always
---

# MCP Server Development

Guidelines for building the Code Graph Analyzer MCP server.

## MCP Server Architecture

The MCP server (`src/mcp/`) exposes the query engine to AI editors (Kiro, Claude, Cursor, Windsurf).

```
AI Editor (Kiro/Claude/Cursor)
    ↓ MCP Protocol
MCP Server (@modelcontextprotocol/sdk)
    ↓ HTTP
Query Server (Fastify)
    ↓
Neo4j + pgvector
```

## Tool Registration

Each query type maps to one MCP tool:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new Server(
  {
    name: "code-graph-analyzer",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "analyze_impact",
      description: "Analyze the impact of changing a symbol",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Symbol name or ID" },
          maxResults: { type: "number", default: 50 },
        },
        required: ["target"],
      },
    },
    // ... other tools
  ],
}));
```

## Tool Response Format

Every MCP tool response MUST include a `summary` field (Req 15.8):

```typescript
interface MCPToolResponse {
  symbols: Array<{
    id: string;
    name: string;
    kind: SymbolKind;
    location: { filePath: string; startLine: number };
    relationship: string;
  }>;
  clusters: Array<{
    id: string;
    name: string;
    category: ClusterCategory;
    confidence: number;
  }>;
  processes: Array<{
    id: string;
    name: string;
    stepNumber: number;
    totalSteps: number;
  }>;
  confidence: number;
  riskLevel: RiskLevel;
  affectedFlows: string[];
  summary: string;  // REQUIRED — human-readable, used directly by AI editors
}
```

The `summary` field should be a concise, human-readable description of the results:

```typescript
function formatSummary(result: QueryResult): string {
  const { intent, symbols, confidence, riskLevel } = result;
  
  if (intent.type === "impactAnalysis") {
    return `Changing ${intent.target} affects ${symbols.length} symbols with ${riskLevel} risk (confidence: ${(confidence * 100).toFixed(0)}%)`;
  }
  
  if (intent.type === "dataFlowTrace") {
    return `Traced ${result.processes[0]?.steps.length || 0} steps from ${intent.entryPoint} through ${result.clusters.length} functional areas`;
  }
  
  // ... other intent types
}
```

## Security Requirements

- Token-based authentication for MCP connections (Req 22.5)
- Sanitize all natural language query inputs (Req 22.3)
- Validate file paths for directory traversal (Req 22.4)
- Never send full source code to external APIs (Req 22.2)

```typescript
function sanitizeQuery(query: string): string {
  // Remove SQL injection patterns
  return query.replace(/[;'"\\]/g, "");
}

function validateFilePath(path: string): boolean {
  // Prevent directory traversal
  return !path.includes("..") && !path.startsWith("/");
}
```

## Testing MCP Tools

Test MCP tools immediately after implementation:

```typescript
// tests/integration/mcp-integration.test.ts
import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

describe("MCP Server", () => {
  it("should return summary field in impact analysis response", async () => {
    const response = await callTool("analyze_impact", {
      target: "UserService.login",
    });
    
    expect(response.summary).toBeDefined();
    expect(typeof response.summary).toBe("string");
    expect(response.summary.length).toBeGreaterThan(0);
  });

  it("should include confidence score in all responses", async () => {
    const response = await callTool("smart_search", {
      query: "authentication flow",
    });
    
    expect(response.confidence).toBeGreaterThanOrEqual(0);
    expect(response.confidence).toBeLessThanOrEqual(1);
  });
});
```

## Client Configuration

Users configure the MCP server in `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "code-graph-analyzer": {
      "command": "node",
      "args": ["dist/mcp/index.js"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "password",
        "POSTGRES_URI": "postgresql://localhost:5432/typocop",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Error Handling

Return structured errors that AI editors can understand:

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await executeQuery(request.params.arguments);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof ParseError) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: "ParseError",
            message: error.message,
            filePath: error.filePath,
          }),
        }],
        isError: true,
      };
    }
    throw error;
  }
});
```

## Performance Targets

- Simple queries: < 500ms
- Complex graph traversals: < 2s
- MCP tool response time includes query execution + formatting

## Development Workflow

1. Implement query type in `src/query/`
2. Add MCP tool registration in `src/mcp/`
3. Test with sample calls immediately
4. Verify `summary` field is present and meaningful
5. Test with real AI editor (Kiro)
6. Document tool usage in README

## Debugging MCP Server

```bash
# Run MCP server directly
node dist/mcp/index.js

# Test with stdio transport
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/mcp/index.js

# Check logs
tail -f ~/.kiro/logs/mcp-code-graph-analyzer.log
```

## Integration with AI Editors

The MCP server enables AI editors to:
- Understand complete code context in one query (no iterative searches)
- Get confidence scores for all results (90%+ target)
- Assess blast radius automatically (LOW/MEDIUM/HIGH/CRITICAL)
- Trace execution flows from entry points
- Find related code by semantic similarity

This eliminates the need for 10+ file reads per question — the AI gets complete context in a single tool call.
