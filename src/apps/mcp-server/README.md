# MCP Server Module

Model Context Protocol (MCP) server implementation for the Code Graph Analyzer.

## Overview

This module provides MCP integration for AI editors (Kiro, Claude, Cursor, Windsurf, Antigravity) to query the code knowledge graph. It implements:

- **Protocol Handling**: Request validation, error responses, connection state management
- **Tool Registration**: 17 read-only MCP tools for querying the knowledge graph (including the `verify_claim` grounding / anti-hallucination tool, the guarded `query_graph` Cypher tool, and the data-touch enumeration tools `route_map` / `what_reads_table` / `what_writes_table` / `what_publishes_to` / `what_subscribes_to`)
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

**17 read-only tools** — none mutate your code or the graph. Every response carries a mandatory human-readable `summary` (see [Response Format](#response-format)).

### Context & search

#### `get_symbol_context`

360° context for a symbol: callers, callees, clusters, and processes.

- `symbolName` (required) — symbol to analyze
- `filePath` (optional) — narrow an ambiguous name
- `maxResults` (optional, default 100)
- `tokenBudget` (optional) — cap estimated tokens; slices target + direct neighbours in BFS order to fit (`pin`ned ids are always kept). `0` = unlimited
- `pin` (optional, `string[]`) — symbol ids to always include in the slice
- `maxDepth` (optional) — slice hop distance (default 1 = target + direct neighbours)

```json
{ "method": "get_symbol_context", "params": { "symbolName": "CustomerRepository", "filePath": "src/repositories/customer.ts" } }
```

#### `smart_search`

Find symbols by **natural-language query** using semantic (vector) similarity. Use when you don't know the exact name.

- `query` (required) — natural-language description
- `maxResults` (optional, default 100)

### Dependencies, impact & tracing

#### `impact_analysis`

Blast radius of a symbol: all direct **and transitive** dependents (callers), affected business flows, and a risk level (CRITICAL for auth/payment/checkout/security/session/token code), with each affected node annotated by its structural role, entry edge, and hop distance. Answers both *"who depends on / calls X?"* and *"what breaks if I change X?"*.

- `symbolName` (required)
- `changeType` (optional) — `modify` | `delete` | `rename` (default `modify`); affects the summary framing only
- `maxDepth` (optional) — max transitive depth (default unlimited, capped at 20)
- `maxResults` (optional, default 100)

> Subsumes the former `find_dependents` tool — pass `maxDepth` to bound the caller traversal.

```json
{ "method": "impact_analysis", "params": { "symbolName": "PaymentService::processPayment", "changeType": "modify", "maxDepth": 3 } }
```

#### `trace`

Shortest call/containment path between two symbols over `CALLS`|`CONTAINS` edges — the per-hop chain (symbol, file:line, edge type).

- `fromSymbol` (required), `toSymbol` (required)
- `maxDepth` (optional, default + cap 20)

#### `trace_data_flow`

Trace data flow from an API entry point through services to database models.

- `entryPoint` (required) — API endpoint, controller, etc.
- `framework` (optional) — NestJS / Laravel / Express / …
- `maxResults` (optional, default 100)

### Code quality

#### `find_dead_code`

Likely-dead-code candidates: symbols with no incoming `CALLS` edge that are neither exported nor entry-point-named (main/handlers/REST verbs/controllers). **Read-only — never deletes;** candidates must be verified (dynamic/reflective calls aren't tracked).

- `kind` (optional) — restrict to a `SymbolKind` (function/class/method/…)
- `maxResults` (optional, default 100)

#### `find_hotspots`

Complexity hotspots: the most cyclomatically-complex symbols, ranked highest-first and paged. Each result carries `cyclomatic`, `cognitive` (nesting-weighted), and `maxLoopDepth`.

- `minComplexity` (optional, exclusive, default 10)
- `maxResults` (optional, default 50)
- `offset` (optional, default 0)

### API contracts

#### `shape_check`

Detect API contract drift. With **no args**: graph-wide — compares each route's top-level response keys (`res.json`/`res.send`/`return {...}`) against the keys consumers read, and reports every key a consumer reads that no route returns. With **`route`**: scopes to that route — its blast radius (affected symbols, flows, risk) **plus** the consumer mismatches. v1: top-level keys only.

- `route` (optional) — route symbol name (e.g. `GET /users` or the handler name). Omit for graph-wide drift.

> The `route` mode subsumes the former `api_impact` tool.

### Refactoring

#### `rename`

**PREVIEW** a coordinated rename: the definition + edge-backed reference sites (CALLS/IMPORTS/REFERENCES) as high-confidence file:line edits, plus a word-boundary regex for the low-confidence text tail. **Preview only — never writes files or the graph.**

- `symbolName` (required), `newName` (required — a valid identifier)
- `filePath` (optional) — disambiguate an ambiguous name

### Change-driven

#### `detect_changes`

Detect uncommitted/git changes and analyze their blast radius (affected symbols, flows, risk; elevates to CRITICAL for auth/payment/checkout/security/session/token code).

- `scope` (optional) — `unstaged` (default) | `staged` | `all` | `compare`
- `baseRef` (required when `scope` = `compare`) — e.g. `main` or a commit SHA
- `maxResults` (optional, default 100)

### Grounding / anti-hallucination

#### `verify_claim`

Verify a **structured belief** about the codebase and get back **verdict (`confirmed` / `refuted` / `uncertain`) + confidence + evidence** — so an agent stops acting on false assumptions ("nothing calls X, safe to delete"). **Honest-uncertainty is mandatory:** any relationship the graph can't prove (dynamic dispatch / callbacks / DI) is reported `uncertain`, never a false confirm/refute; a refute includes the **true answer** (e.g. the real caller set). Read-only; never throws — parse errors, unresolved symbols, and timeouts all degrade to a graceful `uncertain`.

Claim kinds (discriminated by `kind`):

- `usage` — *"X has no callers / is dead"*. Needs `symbol`.
- `edge` — *"X {relation} Y"*. Needs `from`, `to`, and `relation` ∈ `calls` | `imports` | `inherits` | `implements` | `references` | `overrides` | `methodImplements` (`overrides` = a subclass method overrides an ancestor's; `methodImplements` = a method satisfies an interface/trait contract).
- `reachability` — *"X can reach Y"* / *"changing X can't affect Y"*. Needs `from`, `to`, and `polarity` ∈ `reachable` | `independent`.

```json
{ "method": "verify_claim", "params": { "kind": "edge", "from": "OrderService", "to": "PaymentGateway", "relation": "calls" } }
```

### Ad-hoc graph queries

#### `query_graph`

Run a **guarded, read-only** Cypher query against the knowledge graph for questions the canned tools don't cover. **Strictly read-only:** a single `MATCH`/`OPTIONAL MATCH`/`WITH`/`UNWIND`/`RETURN` statement only — any mutation/DDL/procedure (`CREATE`/`MERGE`/`SET`/`DELETE`/`DETACH`/`REMOVE`/`DROP`/`ALTER`/`CALL`/`LOAD`/`COPY`/…) or a second statement is **rejected before execution** (keywords are matched as whole words after string-literals and comments are stripped). Results are **row-capped** (default 100, hard max 200) and time-bounded; the persisted node/edge-label prefix is stripped from results. Write labels **bare** (`:Symbol`, `[:CALLS]`) — the schema prefix is added/stripped automatically. Node labels: `Symbol`, `Cluster`, `Process`, `Metadata`, `ExternalDependency`; edge types: `CALLS`, `IMPORTS`, `INHERITS`, `IMPLEMENTS`, `CONTAINS`, `HAS_STEP`, `REFERENCES`, `DEFINES`, `DEPENDS_ON`, `OVERRIDES`, `METHODIMPLEMENTS`.

- `cypher` (required) — a single read-only Cypher statement (bare labels)
- `limit` (optional) — max rows (default 100, hard max 200)

```json
{ "method": "query_graph", "params": { "cypher": "MATCH (s:Symbol) WHERE NOT (s)<-[:CALLS]-() RETURN s.name", "limit": 50 } }
```

Rows are returned in the additive `queryGraph` block (`ok` / `rows[]` / `rowCount` / `limit` / `truncated`; `unsupported` carries the rejection reason when `ok` is false).

### Data flow, tables & events

These tools read the persisted **data-touch edges** (`HANDLES_ROUTE` / `READS_FROM_DB` / `WRITES_TO_DB` / `PUBLISHES_EVENT` / `SUBSCRIBES_TO`) that the indexer emits when data-touch indexing is enabled (`TYPOCOP_DATA_TOUCH`; events additionally gated by `TYPOCOP_DATA_TOUCH_EVENTS`, **OFF by default**). When that pass did not run at index time the edge tables are empty, so each tool **degrades to a clear empty result** (low confidence + a "may be disabled" summary) — never an error.

#### `route_map`

List **all** API routes the indexer linked a handler to (via `HANDLES_ROUTE`) — endpoint + serving handler + provenance. Covers decorator (NestJS/Spring), Express/Fastify, and structured framework routes (incl. Laravel resource expansion). *Enumerates* the route surface — distinct from `trace_data_flow` (traces **from** one endpoint) and `shape_check` (response-contract drift).

- `maxResults` (optional, default 100)

Rows ride the additive `routeMap` block (`routes[]` of endpoint/handler + `confidence`/`reason`; `totalFound`).

```json
{ "method": "route_map", "params": {} }
```

#### `what_reads_table` / `what_writes_table`

Given a **table/model name**, list the code symbols that **read from** / **write to** it (via `READS_FROM_DB` / `WRITES_TO_DB`). Keyed on **data edges**, not `CALLS` — distinct from `impact_analysis`. Resolves the table to its `dbmodel:<table>` synthetic node **or** a real model class (case-insensitive name match).

- `table` (required) — e.g. `users` or `User`
- `maxResults` (optional, default 100)

Touchers ride the additive `tableTouch` block (`table` / `direction` / `touchers[]` with `confidence`/`reason`; `totalFound`).

```json
{ "method": "what_reads_table", "params": { "table": "users" } }
```

#### `what_publishes_to` / `what_subscribes_to`

Given an **event topic**, list the code symbols that **publish to** / **subscribe to** it (via `PUBLISHES_EVENT` / `SUBSCRIBES_TO`). Resolves the topic to its `eventchannel:<topic>` node. **Event indexing is OFF by default** even when data-touch is on — these return an empty result when events were not indexed.

- `topic` (required) — e.g. `order.created`
- `maxResults` (optional, default 100)

Participants ride the additive `eventChannel` block (`topic` / `direction` / `participants[]` with `confidence`/`reason`; `totalFound`).

```json
{ "method": "what_subscribes_to", "params": { "topic": "order.created" } }
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

Some tools attach **additive, optional** fields to this base shape (absent for every other tool, so the wire contract stays backward-compatible):

| Field | Populated by |
|-------|--------------|
| `verdict` (verdict / confidence / reason / evidence / counterexample / trueAnswer) | `verify_claim` |
| `trace` (found / length / hops[]) | `trace` |
| `rename` (preview plan: edits[] + low-confidence regex) | `rename` |
| `shapeCheck` (pairsChecked / mismatches[]) | `shape_check` |
| per-symbol `nodeRole` / `entryEdge` / `hopDistance` | `impact_analysis` |
| per-symbol `cyclomatic` / `cognitive` / `maxLoopDepth` | `find_hotspots` |
| `truncationReason` / `estimatedTokens` | `get_symbol_context` (with a `tokenBudget`) |
| `heritage` (ancestors / interfaces / overrides) | `get_symbol_context` (class/interface/method target) |
| `symbolInsights` (language / languageCoverage / modelDocumentation) | `get_symbol_context` |
| `queryGraph` (ok / rows[] / rowCount / limit / truncated / unsupported) | `query_graph` |
| `routeMap` (routes[] / totalFound) | `route_map` |
| `tableTouch` (table / direction / touchers[] / totalFound) | `what_reads_table`, `what_writes_table` |
| `eventChannel` (topic / direction / participants[] / totalFound) | `what_publishes_to`, `what_subscribes_to` |

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
  adapter,         // DatabaseAdapter (LadybugDB graph + vector + embeddings)
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
pnpm test src/apps/mcp-server/
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
