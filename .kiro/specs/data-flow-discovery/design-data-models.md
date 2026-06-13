Part of the [Data Flow Discovery Design](./design.md).

# Data Models & Algorithms

## New Node Labels

```typescript
// APIEndpoint — HTTP route. ID: "APIEndpoint:{METHOD}:{path}"
// Properties: name, filePath, startLine?, httpMethod, httpPath

// DBModel — ORM entity / table. ID: "DBModel:{tableName}"
// Properties: name, filePath, startLine?, dbTable

// EventChannel — pub/sub topic. ID: "EventChannel:{eventName}"
// Properties: name, filePath, eventName

// DataFlow — end-to-end traced flow. ID: "DataFlow:flow_{idx}_{entry}"
// Properties: name, filePath, httpMethod?, httpPath?, dbTable?, stepCount,
//   communities[], entryPointId, terminalId, dataEntities[], trace[]
```

Validation: APIEndpoint `httpMethod` valid HTTP method, `httpPath` starts with `/`. DBModel `dbTable` non-empty. DataFlow `stepCount >= 2`, `trace.length === stepCount`.

## New Relationship Types

- `HANDLES_ROUTE`: Symbol → APIEndpoint
- `WRITES_TO_DB` / `READS_FROM_DB`: Symbol → DBModel
- `PUBLISHES_EVENT`: Symbol → EventChannel
- `SUBSCRIBES_TO`: EventChannel → Symbol
- `STEP_IN_FLOW`: Symbol → DataFlow (with `step: number` property, 1-indexed)

## Algorithm 1: Data Touch Detection

```
detectDataTouches(graphAdapter) → DataTouchResult
PRE: Symbol nodes exist from Phases 1-3
POST: APIEndpoint/DBModel/EventChannel nodes + edges created, idempotent

1. Query all Symbol nodes
2. For each: match route decorators → create APIEndpoint + HANDLES_ROUTE
3. For classes/interfaces: match ORM patterns → create DBModel
4. Scan CALLS edges: match DB read/write methods → create READS_FROM_DB/WRITES_TO_DB
5. Match event patterns → create EventChannel + PUBLISHES_EVENT/SUBSCRIBES_TO
```

## Algorithm 2: Data Flow Assembly (BFS)

```
assembleDataFlows(graphAdapter, config) → DataFlowAssemblyResult
PRE: Data touch detection complete, config values > 0
POST: DataFlow nodes + STEP_IN_FLOW edges, unique entry+terminal, <= maxFlows
INVARIANT: BFS paths acyclic, path.length <= maxTraceDepth

1. Build forward adjacency from {CALLS, WRITES_TO_DB, READS_FROM_DB, PUBLISHES_EVENT, SUBSCRIBES_TO}
2. Find entry points: APIEndpoint handlers + high-score functions
3. BFS from each entry point:
   - Queue: [{nodeId, path}], dequeue and expand neighbors
   - Limit: maxBranching neighbors per node, maxTraceDepth path length
   - Cycle prevention: skip if targetId already in path
   - Terminal: no neighbors or depth reached → emit trace if >= minSteps
4. Deduplicate by entry+terminal (prefer DB-touching, longer traces)
5. Create DataFlow nodes + STEP_IN_FLOW edges for top maxFlows traces
```

## Algorithm 3: Data Flow Discovery Query

```
executeDataFlowDiscovery(filter, maxResults, graphAdapter) → DataFlowDiscoveryResult
PRE: DataFlow nodes exist, maxResults > 0
POST: flows.length <= maxResults, traces ordered by step, confidence in [0,1]

1. Build Cypher: MATCH (df:DataFlow) + WHERE clauses from filter (parameterized)
2. ORDER BY df.stepCount DESC LIMIT maxResults
3. For each flow: query STEP_IN_FLOW edges → build trace with symbol details
4. Confidence: 0.92 if API→DB flows exist, 0.75 if any flows, 0.5 if empty
```

## Example Usage

```typescript
// Indexer pipeline integration
const touchResult = await detectDataTouches(graphAdapter);
const flowResult = await assembleDataFlows(graphAdapter, { maxFlows: 200 });

// MCP tool — discover POST flows touching "users" table
const response = await executeTool("discover_data_flows", {
  httpMethod: "POST", dbTable: "users", maxResults: 20,
}, adapter);

// Query layer direct usage
const result = await executeDataFlowDiscovery(
  { pathPattern: "/api/auth" }, 50, graphAdapter,
);
for (const flow of result.flows) {
  console.log(`${flow.name} (${flow.stepCount} steps)`);
  for (const step of flow.trace) {
    console.log(`  ${step.step}. ${step.symbolName} (${step.filePath})`);
  }
}
```
