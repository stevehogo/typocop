# Requirements: Data Flow Discovery Tool

Derived from the [Design Document](./design.md).

## Requirement 1: Data Touch Detection

The indexer pipeline must detect data-aware nodes and relationships from existing Symbol nodes.

### Acceptance Criteria

- 1.1 Detect API endpoints from NestJS decorators (@Get, @Post, @Put, @Delete, @Patch), Spring (@GetMapping, @PostMapping, etc.), Express-style route calls (app.get, router.post), and Laravel/FastAPI/Django patterns
- 1.2 Create APIEndpoint nodes with valid httpMethod and httpPath (starting with `/`)
- 1.3 Detect DB models from ORM patterns: TypeORM @Entity, Prisma model usage, Mongoose Schema, Eloquent Model, and class name heuristics (ending in Entity/Model/Schema)
- 1.4 Create DBModel nodes with non-empty dbTable property
- 1.5 Detect DB read/write operations by analyzing CALLS edges to known DB methods (find, create, save, update, delete, etc.) and create READS_FROM_DB / WRITES_TO_DB relationships
- 1.6 Detect event channels from pub/sub patterns (@EventPattern, emit, publish, subscribe) and create EventChannel nodes with PUBLISHES_EVENT / SUBSCRIBES_TO relationships
- 1.7 Create HANDLES_ROUTE relationships linking handler Symbol nodes to their APIEndpoint nodes
- 1.8 Detection must be idempotent — running twice produces the same graph state

## Requirement 2: Data Flow Assembly

The indexer must assemble end-to-end DataFlow nodes by BFS-tracing from entry points through data-aware edges.

### Acceptance Criteria

- 2.1 Build forward adjacency from CALLS, WRITES_TO_DB, READS_FROM_DB, PUBLISHES_EVENT, SUBSCRIBES_TO edges
- 2.2 Identify entry points: APIEndpoint route handlers (via HANDLES_ROUTE) and high-score entry point functions
- 2.3 BFS trace from each entry point with configurable maxTraceDepth (default 12), maxBranching (default 4), maxFlows (default 200), minSteps (default 2)
- 2.4 Prevent cycles in traces — all nodes in a traced path must be distinct
- 2.5 Deduplicate flows by entry+terminal endpoint pair, preferring DB-touching flows and longer traces
- 2.6 Create DataFlow nodes with metadata: httpMethod, httpPath, dbTable, stepCount, communities, entryPointId, terminalId, dataEntities, trace
- 2.7 Create STEP_IN_FLOW edges with sequential step numbers (1-indexed) linking symbols to their DataFlow
- 2.8 Total assembled flows must not exceed maxFlows configuration limit

## Requirement 3: Data Flow Discovery Query

A query function must discover and filter DataFlow nodes from the graph at query time.

### Acceptance Criteria

- 3.1 Support filtering by httpMethod (exact match), pathPattern (substring match on httpPath), dbTable (exact match), and domainConcept
- 3.2 Return structured DiscoveredFlow objects with id, name, httpMethod, httpPath, dbTables, stepCount, dataEntities, and ordered trace
- 3.3 Each trace entry includes step number, symbolId, symbolName, filePath, and kind
- 3.4 Result count must not exceed the maxResults parameter
- 3.5 Confidence score in [0.0, 1.0]: 0.92 for API→DB flows, 0.75 for any flows, 0.5 when empty
- 3.6 Return resolution kind "no_flows" when no DataFlow nodes match the query
- 3.7 All filter values must be passed as Cypher parameters (never string-interpolated)

## Requirement 4: MCP Tool Registration

A new `discover_data_flows` MCP tool must be registered and functional.

### Acceptance Criteria

- 4.1 Register tool with name "discover_data_flows" in the MCP server tool definitions
- 4.2 Accept optional parameters: httpMethod, pathPattern, dbTable, domainConcept, maxResults
- 4.3 Return MCPToolResponse with symbols, clusters, processes, confidence, riskLevel, affectedFlows, and summary
- 4.4 Summary field must be human-readable and describe the number of flows found and filter criteria
- 4.5 Add handler in executeTool switch statement following existing tool patterns
- 4.6 Default maxResults to 50 when not provided

## Requirement 5: Pipeline Integration

Data touch detection and flow assembly must integrate into the existing 6-phase indexer pipeline.

### Acceptance Criteria

- 5.1 Run data touch detection after Phase 5 (Processes) and before Phase 6 (Search)
- 5.2 Run data flow assembly after data touch detection
- 5.3 Support progress callbacks for both phases
- 5.4 Pipeline errors in detection/assembly must halt the pipeline per existing error handling (Req 3.7)
- 5.5 New indexer code must live in `src/indexer/data-touch/` directory

## Requirement 6: Performance & Resource Limits

The feature must respect existing performance targets and resource limits.

### Acceptance Criteria

- 6.1 Data touch detection + flow assembly completes in < 5 seconds for 10K-symbol graphs
- 6.2 Discovery queries complete in < 500ms
- 6.3 BFS traversal depth bounded by MAX_TRAVERSAL_DEPTH from limits.ts
- 6.4 Forward adjacency built in-memory for O(1) neighbor lookup during BFS

## Requirement 7: Security

All query inputs must be sanitized and no source code stored in flow nodes.

### Acceptance Criteria

- 7.1 All Cypher queries use parameterized values — no string interpolation
- 7.2 httpMethod filter validated against allowed HTTP method set
- 7.3 File paths in results are relative to repo root (no absolute paths)
- 7.4 No source code stored in DataFlow, APIEndpoint, DBModel, or EventChannel nodes
