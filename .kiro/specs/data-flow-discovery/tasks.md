# Tasks: Data Flow Discovery Tool

- [ ] 1. Define data flow types in `src/types/index.ts`
  _Skills: `typescript-expert`, `clean-code`
  - [ ] 1.1 Add `DataFlowRelationType` union type for HANDLES_ROUTE, WRITES_TO_DB, READS_FROM_DB, PUBLISHES_EVENT, SUBSCRIBES_TO, STEP_IN_FLOW
  - [ ] 1.2 Add `DataFlowFilter` interface with optional httpMethod, pathPattern, dbTable, domainConcept fields
  - [ ] 1.3 Add `DataFlowConfig` interface with maxTraceDepth, maxBranching, maxFlows, minSteps
  - [ ] 1.4 Add `DiscoveredFlow` interface with id, name, httpMethod, httpPath, dbTables, stepCount, dataEntities, trace
  - [ ] 1.5 Add `DataTouchResult` and `DataFlowAssemblyResult` interfaces
  Requirements: 1.2, 1.4, 2.6, 3.2

- [ ] 2. Implement data touch detector (`src/indexer/data-touch/detector.ts`)
  _Skills: `typescript-expert`, `clean-code`, `architecture`
  - [ ] 2.1 Implement `detectAPIEndpoints` — scan Symbol nodes for route decorator patterns (NestJS, Spring, Express, Laravel) and create APIEndpoint nodes + HANDLES_ROUTE edges
  - [ ] 2.2 Implement `detectDBModels` — scan Symbol nodes for ORM entity patterns (TypeORM, Prisma, Mongoose, Eloquent) and create DBModel nodes
  - [ ] 2.3 Implement `linkDBOperations` — scan CALLS edges for DB read/write method names and create READS_FROM_DB / WRITES_TO_DB edges with model resolution
  - [ ] 2.4 Implement `detectEventChannels` — scan for pub/sub patterns and create EventChannel nodes + PUBLISHES_EVENT / SUBSCRIBES_TO edges
  - [ ] 2.5 Implement main `detectDataTouches` function orchestrating all sub-detectors with progress callbacks
  Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8

- [ ] 3. Implement data flow assembler (`src/indexer/data-touch/assembler.ts`)
  _Skills: `typescript-expert`, `architecture`, `nodejs-best-practices`
  - [ ] 3.1 Implement `buildForwardAdjacency` — build in-memory adjacency map from data-aware edges via Cypher queries
  - [ ] 3.2 Implement `findDataEntryPoints` — find APIEndpoint handlers and high-score entry functions
  - [ ] 3.3 Implement `traceDataFlow` — BFS from entry point with cycle prevention, depth/branching limits
  - [ ] 3.4 Implement `deduplicateFlows` — deduplicate by entry+terminal, prefer DB-touching and longer traces, remove subsets
  - [ ] 3.5 Implement main `assembleDataFlows` function: build adjacency, find entries, trace, dedup, create DataFlow nodes + STEP_IN_FLOW edges
  Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8

- [ ] 4. Implement data flow discovery query (`src/query/data-flow-discovery.ts`)
  _Skills: `typescript-expert`, `clean-code`, `error-handling-patterns`
  - [ ] 4.1 Implement `executeDataFlowDiscovery` — build parameterized Cypher query with optional WHERE clauses from filter
  - [ ] 4.2 Implement step trace resolution — query STEP_IN_FLOW edges per flow and build ordered trace with symbol details
  - [ ] 4.3 Implement confidence computation — 0.92 for API→DB flows, 0.75 for any flows, 0.5 when empty
  Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7

- [ ] 5. Register MCP tool and add handler
  _Skills: `typescript-expert`, `clean-code`
  - [ ] 5.1 Add `discover_data_flows` tool definition to TOOL_DEFINITIONS in `src/mcp/registration.ts`
  - [ ] 5.2 Add `executeDiscoverDataFlows` handler function in `src/mcp/tools.ts`
  - [ ] 5.3 Add `"discover_data_flows"` case to `executeTool` switch in `src/mcp/tools.ts`
  Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6

- [ ] 6. Integrate into indexer pipeline
  _Skills: `typescript-expert`, `architecture`
  - [ ] 6.1 Add `detectDataTouches` and `assembleDataFlows` calls after Phase 5 in the pipeline orchestrator
  - [ ] 6.2 Wire progress callbacks to pipeline progress reporting
  Requirements: 5.1, 5.2, 5.3, 5.4, 5.5

- [ ] 7. Write unit tests for data touch detector
  _Skills: `testing-patterns`, `tdd-workflow`
  - [ ] 7.1 Test `detectAPIEndpoints` with mock graph containing NestJS, Express, and Spring decorator patterns
  - [ ] 7.2 Test `detectDBModels` with mock graph containing TypeORM, Prisma, and Eloquent patterns
  - [ ] 7.3 Test `linkDBOperations` with mock CALLS edges to known read/write methods
  - [ ] 7.4 Test `detectEventChannels` with mock pub/sub patterns
  - [ ] 7.5 Test idempotency — running detection twice produces same result
  Requirements: 1.1–1.8

- [ ] 8. Write unit tests for data flow assembler
  _Skills: `testing-patterns`, `tdd-workflow`
  - [ ] 8.1 Test BFS tracing on a known graph topology — verify correct paths found
  - [ ] 8.2 Test cycle prevention — graph with cycles produces acyclic traces
  - [ ] 8.3 Test deduplication — overlapping traces reduced to unique entry+terminal pairs
  - [ ] 8.4 Test config limits — maxTraceDepth, maxBranching, maxFlows, minSteps all respected
  Requirements: 2.1–2.8

- [ ] 9. Write unit tests for discovery query and MCP tool
  _Skills: `testing-patterns`, `tdd-workflow`
  - [ ] 9.1 Test `executeDataFlowDiscovery` with various filter combinations against mock graph
  - [ ] 9.2 Test maxResults limit is respected
  - [ ] 9.3 Test "no_flows" resolution when graph has no DataFlow nodes
  - [ ] 9.4 Test MCP tool handler returns valid MCPToolResponse with summary
  Requirements: 3.1–3.7, 4.1–4.6

- [ ] 10. Write property-based tests
  _Skills: `testing-patterns`
  - [ ] 10.1 Property: assembled flows respect all config limits (maxFlows, minSteps, maxTraceDepth)
  - [ ] 10.2 Property: BFS never produces cycles in traces
  - [ ] 10.3 Property: deduplication is idempotent
  - [ ] 10.4 Property: discovery result count <= maxResults
  - [ ] 10.5 Property: confidence always in [0.0, 1.0]
  - [ ] 10.6 Property: step ordering is sequential with no gaps (step[i] === i + 1)
  Requirements: Correctness Properties 1–13
