Part of the [Data Flow Discovery Design](./design.md).

# Correctness Properties & Testing

## Correctness Properties

Properties verified with `fast-check` property-based tests:

1. **DataFlow Step Ordering**: ∀ flow ∈ DataFlows, ∀ i ∈ [0, trace.length-1]: trace[i].step === i + 1
2. **DataFlow Minimum Length**: ∀ flow ∈ DataFlows: flow.stepCount >= config.minSteps
3. **DataFlow Step Count Consistency**: ∀ flow ∈ DataFlows: flow.trace.length === flow.stepCount
4. **DataFlow No Cycles**: ∀ flow ∈ DataFlows: allDistinct(flow.trace.map(s => s.symbolId))
5. **DataFlow Uniqueness**: ∀ f1, f2 where f1 ≠ f2: (f1.entryPointId, f1.terminalId) ≠ (f2.entryPointId, f2.terminalId)
6. **DataFlow Max Limit**: |DataFlows| <= config.maxFlows
7. **Discovery Result Limit**: ∀ query with maxResults=N: result.flows.length <= N
8. **Discovery Confidence Bounds**: ∀ result: 0.0 <= result.confidence <= 1.0
9. **APIEndpoint Valid Method**: ∀ ep: ep.httpMethod ∈ {"GET","POST","PUT","DELETE","PATCH","OPTIONS","HEAD","ALL","ANY"}
10. **APIEndpoint Valid Path**: ∀ ep: ep.httpPath.startsWith("/")
11. **DBModel Non-Empty Table**: ∀ m: m.dbTable.length > 0
12. **STEP_IN_FLOW References Valid**: ∀ edge: sourceId → existing Symbol, targetId → existing DataFlow
13. **Filter Correctness**: ∀ query with filter.httpMethod=M: ∀ flow ∈ result: flow.httpMethod === M

## Formal Specifications

### detectDataTouches()

**Preconditions**: graphAdapter initialized, Symbol nodes exist (Phases 1-3 complete)
**Postconditions**: Non-negative counts, valid httpMethod/httpPath on APIEndpoints, non-empty dbTable on DBModels, all edges reference existing nodes, idempotent
**Loop Invariants**: No node ID collisions (deterministic generation)

### assembleDataFlows()

**Preconditions**: graphAdapter initialized, data touch detection complete, config values > 0, minSteps >= 2
**Postconditions**: totalFlows <= maxFlows, stepCount >= minSteps per flow, trace.length === stepCount, unique entry+terminal pairs, sequential STEP_IN_FLOW step values
**Loop Invariants (BFS)**: All path nodes distinct, path.length <= maxTraceDepth, results <= maxBranching * 4 per entry

### executeDataFlowDiscovery()

**Preconditions**: graphAdapter initialized, maxResults > 0, filter values sanitized
**Postconditions**: flows.length <= maxResults, traces ordered ascending by step, confidence in [0.0, 1.0], no_flows when empty

### deduplicateFlows()

**Preconditions**: Each flow has >= minSteps, steps ordered
**Postconditions**: Unique entry+terminal pairs, DB-touching preferred, longer preferred, no subsets, result.length <= input.length

## Testing Strategy

### Unit Tests

- `detectDataTouches` with mock GraphAdapter containing known Symbol patterns
- Each detection sub-function: route decorators, ORM patterns, Express routes, events
- `assembleDataFlows` with pre-built adjacency graphs of known topology
- `deduplicateFlows` with overlapping and subset traces
- `executeDataFlowDiscovery` with mock graph containing known DataFlow nodes
- Filter combinations (httpMethod, pathPattern, dbTable)

### Property-Based Tests (fast-check)

- Assembled flows respect all config limits for arbitrary DataFlowConfig
- Discovery results are consistent subsets for arbitrary filter combinations
- BFS never produces cycles in traces
- Deduplication is idempotent: `dedup(dedup(flows)) === dedup(flows)`
- Step ordering is always sequential with no gaps

### Integration Tests

- Full pipeline: index sample NestJS project → verify DataFlow nodes created
- MCP tool: call `discover_data_flows` against indexed graph → verify response format
- Cross-framework: index Express + Laravel samples → verify both produce valid flows

## Performance Considerations

- Detection + assembly runs once during indexing (amortized cost)
- BFS bounded by `maxTraceDepth * maxBranching` per entry point
- Forward adjacency built in-memory for O(1) neighbor lookup
- Discovery queries use indexed Cypher lookups on DataFlow properties
- Target: detection + assembly < 5s for 10K-symbol graphs; discovery < 500ms

## Security Considerations

- All Cypher queries use parameterized values — no string interpolation
- Filter inputs validated: httpMethod against allowed set, pathPattern length-limited
- File paths in results are relative to repo root (no absolute paths)
- No source code stored in DataFlow nodes — only symbol IDs, names, metadata
