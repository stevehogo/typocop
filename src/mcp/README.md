# MCP Server Module

Model Context Protocol (MCP) server implementation for the Code Graph Analyzer.

## Overview

This module provides MCP integration for AI editors (Kiro, Claude, Cursor, Windsurf, Antigravity) to query the code knowledge graph. It implements:

- **Protocol Handling**: Request validation, error responses, connection state management
- **Tool Registration**: 4 MCP tools for querying the knowledge graph
- **Prompt Registration**: Pre-defined prompts for common workflows
- **Authentication**: Token-based authentication for secure connections

## Requirements

Implements requirements:
- 15.1, 15.2: Tool and prompt registration
- 15.3, 15.4: Request validation and error handling
- 15.5, 15.6: Query forwarding and response formatting
- 15.7: Connection state management
- 15.8: Human-readable summary field in all responses
- 22.5: Token-based authentication

## Architecture

```
┌─────────────────┐
│   AI Editor     │
│ (Kiro, Claude)  │
└────────┬────────┘
         │ MCP Protocol
         ▼
┌─────────────────┐
│  MCP Server     │
│  - Validation   │
│  - Auth         │
│  - Tools        │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Query Server   │
│  - Graph DB     │
│  - Vector Store │
└─────────────────┘
```

## MCP Tools

### 1. get_symbol_context

Get 360° context for a symbol: callers, callees, clusters, and processes.

**Parameters:**
- `symbolName` (required): Name of the symbol to analyze
- `filePath` (optional): File path to narrow down the symbol
- `maxResults` (optional): Maximum number of results (default: 50)

**Example:**
```json
{
  "method": "get_symbol_context",
  "params": {
    "symbolName": "CustomerRepository",
    "filePath": "src/repositories/customer.ts"
  }
}
```

### 2. find_dependents

Find all direct and transitive dependents (callers) of a symbol.

**Parameters:**
- `symbolName` (required): Name of the symbol to analyze
- `maxDepth` (optional): Maximum traversal depth
- `maxResults` (optional): Maximum number of results (default: 50)

**Example:**
```json
{
  "method": "find_dependents",
  "params": {
    "symbolName": "UserService::save",
    "maxDepth": 3
  }
}
```

### 3. trace_data_flow

Trace data flow from API endpoint through services to database models.

**Parameters:**
- `entryPoint` (required): Entry point symbol (API endpoint, controller, etc.)
- `framework` (optional): Framework hint (NestJS, Laravel, Express, etc.)
- `maxResults` (optional): Maximum number of results (default: 50)

**Example:**
```json
{
  "method": "trace_data_flow",
  "params": {
    "entryPoint": "POST /api/users",
    "framework": "NestJS"
  }
}
```

### 4. impact_analysis

Analyze blast radius: affected symbols, flows, and risk level.

**Parameters:**
- `symbolName` (required): Name of the symbol to analyze
- `changeType` (optional): Type of change - "modify", "delete", or "rename" (default: "modify")
- `maxResults` (optional): Maximum number of results (default: 50)

**Example:**
```json
{
  "method": "impact_analysis",
  "params": {
    "symbolName": "PaymentService::processPayment",
    "changeType": "modify"
  }
}
```

## Response Format

All tools return `MCPToolResponse` with the following structure:

```typescript
{
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
  confidence: number;       // 0.0–1.0, target >= 0.90
  riskLevel: RiskLevel;     // "low" | "medium" | "high" | "critical"
  affectedFlows: string[];
  summary: string;          // REQUIRED — human-readable summary
}
```

The `summary` field is **mandatory** and provides a human-readable description of the results, designed for direct use by AI editors.

## Authentication

Token-based authentication is implemented for secure MCP connections.

### Configuration

```typescript
import { createAuthConfig } from "./mcp/auth.js";

const authConfig = createAuthConfig(
  ["token1", "token2", "token3"],  // Valid tokens
  true                              // Enable authentication
);
```

### Token Formats

Tokens can be provided in two ways:

1. **Authorization header** (preferred):
   ```
   Authorization: Bearer <token>
   ```

2. **Request params**:
   ```json
   {
     "method": "get_symbol_context",
     "params": {
       "symbolName": "test",
       "token": "<token>"
     }
   }
   ```

### Disabling Authentication

For development or testing:

```typescript
const authConfig = createAuthConfig([], false);
```

## Error Handling

The MCP server returns typed errors for all failure cases:

### Validation Errors

```json
{
  "code": "INVALID_REQUEST_FORMAT",
  "message": "Request must be an object",
  "details": { "received": "string" }
}
```

Error codes:
- `INVALID_REQUEST_FORMAT`: Request is not an object
- `MISSING_METHOD`: Request missing `method` field
- `INVALID_PARAMS`: Request `params` is not an object
- `MISSING_PARAMETER`: Required tool parameter missing
- `INVALID_PARAMETER_TYPE`: Parameter has wrong type
- `INVALID_PARAMETER_VALUE`: Parameter value not in allowed set
- `UNKNOWN_TOOL`: Tool name not recognized

### Authentication Errors

```json
{
  "code": "AUTHENTICATION_FAILED",
  "message": "Invalid authentication token"
}
```

### Internal Errors

```json
{
  "code": "INTERNAL_ERROR",
  "message": "Error message"
}
```

## Connection State

The MCP server maintains connection state for each session:

```typescript
interface ConnectionState {
  sessionId: string;
  connectedAt: Date;
  authenticated: boolean;
}
```

Connection states are stored in a `Map` and persist across requests from the same session.

## Usage Example

```typescript
import { handleMCPRequest, createAuthConfig } from "./mcp/index.js";
import type { MCPContext } from "./mcp/index.js";

// Create context
const context: MCPContext = {
  vectorPool,      // PostgreSQL connection pool
  graphSession,    // Neo4j session
  authConfig: createAuthConfig(["secret-token"], true),
  connectionStates: new Map(),
};

// Handle request
const request = {
  method: "impact_analysis",
  params: {
    symbolName: "UserService::deleteUser",
    changeType: "delete",
    token: "secret-token"
  }
};

const response = await handleMCPRequest(
  request,
  context,
  "session-123",
  { authorization: "Bearer secret-token" }
);

if ("result" in response) {
  console.error(response.result.summary);
  console.error(`Risk: ${response.result.riskLevel}`);
} else {
  console.error(`Error: ${response.message}`);
}
```

## Testing

The module includes comprehensive tests:

- **Unit tests**: `validation.test.ts`, `handler.test.ts`
- **Integration tests**: `integration.test.ts`

Run tests:
```bash
pnpm test src/mcp/
```

All tests verify:
- Request validation
- Authentication flow
- Tool execution
- Response format (including mandatory `summary` field)
- Connection state management
- Error handling

## Files

- `types.ts` - Type definitions and error classes
- `validation.ts` - Request and parameter validation
- `auth.ts` - Token-based authentication
- `handler.ts` - Request handler and connection state
- `tools.ts` - Tool implementations
- `registration.ts` - MCP server creation and tool/prompt registration
- `index.ts` - Public API exports
