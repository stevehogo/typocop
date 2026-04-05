# Process Steps Missing — Bugfix Design

## Overview

`graphNodeToProcess()` is duplicated across three query files and hardcodes `steps: []`,
never fetching `HAS_STEP` edges from Neo4j. This causes `totalSteps: 0` in every MCP tool
response. The fix adds `findProcessSteps(session, processId)` to `src/graph/query.ts` and
extracts a shared `graphNodeToProcess` helper into `src/query/process-helpers.ts` that calls
it, eliminating the duplication and populating steps correctly.

`src/query/smart-search.ts` fetches steps via `p.steps` as a node property — it is NOT
affected by this fix and must not be changed.

## Glossary

- **Bug_Condition (C)**: Any Process node converted via `graphNodeToProcess()` — all are affected
- **Property (P)**: The fixed conversion SHALL populate `steps` by querying `HAS_STEP` edges
- **Preservation**: All non-process fields (symbols, clusters, confidence, riskLevel, affectedFlows) and process discovery logic must remain unchanged
- **`graphNodeToProcess`**: The function in all three query files that converts a `GraphNode` to a `Process` — currently hardcodes `steps: []`
- **`findProcessSteps`**: New function in `src/graph/query.ts` that queries `HAS_STEP` edges for a given process ID
- **`process-helpers.ts`**: New shared file at `src/query/process-helpers.ts` containing the fixed `graphNodeToProcess` to avoid duplication

## Bug Details

### Bug Condition

The bug manifests whenever a `Process` node is fetched from Neo4j and converted to a `Process`
object. The `graphNodeToProcess()` function in all three query files unconditionally returns
`steps: []`, ignoring any `HAS_STEP` edges stored in the graph.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT: X of type GraphNode with label "Process"
  OUTPUT: boolean

  // Every Process node conversion is affected — steps is always []
  RETURN true
END FUNCTION
```

### Examples

- Process node `p1` has 3 `HAS_STEP` edges → `graphNodeToProcess(p1)` returns `steps: []`, `totalSteps: 0` (expected: `steps.length === 3`, `totalSteps: 3`)
- Process node `p2` has 0 `HAS_STEP` edges → `graphNodeToProcess(p2)` returns `steps: []`, `totalSteps: 0` (correct, but for wrong reason)
- `get_symbol_context` tool for a symbol in a 5-step process → MCP response shows `totalSteps: 0` (expected: `5`)
- `impact_analysis` tool for a symbol in two processes → both show `totalSteps: 0` (expected: actual step counts)

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `findProcessesBySymbol()` must return the same set of Process node IDs as before
- All symbol, cluster, relationship, confidence, riskLevel, and affectedFlows fields in query results must be computed with identical logic
- `executePreCommitCheck()`, `executeContextRetrieval()`, and `executeImpactAnalysis()` must return `processes: []` when no processes are found, same as before
- `src/query/smart-search.ts` step fetching logic must not be touched

**Scope:**
All inputs that do NOT involve Process node conversion are completely unaffected. This includes:
- Symbol lookup and conversion (`graphNodeToSymbol`)
- Cluster lookup and conversion (`graphNodeToCluster`)
- Graph traversal (`findDependents`, `findDependencies`)
- Vector/semantic search

## Hypothesized Root Cause

1. **Copy-paste duplication**: `graphNodeToProcess` was written once and copied into all three
   query files. None of the copies ever fetched `HAS_STEP` edges — the `steps` field was
   left as a placeholder `[]` that was never filled in.

2. **Missing query**: No function in `src/graph/query.ts` queries `HAS_STEP` edges. The
   `findProcessesBySymbol` function only returns Process nodes, not their steps.

3. **No test coverage**: The omission went undetected because `totalSteps` in the MCP response
   was never asserted in tests — only its presence was checked.

## Correctness Properties

Property 1: Bug Condition — Process Steps Populated from HAS_STEP Edges

_For any_ Process node where `isBugCondition` holds (i.e., any Process node), the fixed
`graphNodeToProcess(node, session)` SHALL return a `Process` whose `steps.length` equals the
number of `HAS_STEP` edges for that process in Neo4j, with steps ordered ascending by `order`.

**Validates: Requirements 2.1, 2.2**

Property 2: Preservation — Non-Process Query Fields Unchanged

_For any_ input to `executeContextRetrieval`, `executeImpactAnalysis`, or
`executePreCommitCheck`, the fixed code SHALL produce identical `symbols`, `clusters`,
`relationships`, `confidence`, `riskLevel`, and `affectedFlows` values as the original code.
Only the `steps` arrays within `processes` may differ.

**Validates: Requirements 3.2, 3.3, 3.4**

## Fix Implementation

### Changes Required

**New File**: `src/query/process-helpers.ts`

Exports `graphNodeToProcess(node, session)` — an async function that calls `findProcessSteps`
and returns a fully populated `Process`. Also exports `graphNodeToCluster` to consolidate the
duplicated cluster conversion (optional but reduces duplication).

**File**: `src/graph/query.ts`

**New Function**: `findProcessSteps(session, processId)`
- Cypher: `MATCH (p:Process {id: $processId})-[r:HAS_STEP]->(s:Symbol) RETURN s.id AS symbolId, r.order AS order, s.name AS description ORDER BY r.order ASC`
- Returns `ProcessStep[]`

**Files**: `src/query/context-retrieval.ts`, `src/query/impact-analysis.ts`, `src/query/pre-commit-check.ts`

1. Remove the local `graphNodeToProcess` function from each file
2. Import `graphNodeToProcess` from `../query/process-helpers.js`
3. Update all call sites: `processNodes.map(graphNodeToProcess)` →
   `Promise.all(processNodes.map(n => graphNodeToProcess(n, graphSession)))`

**Constraint**: `smart-search.ts` is NOT modified — it fetches steps via `p.steps` node property.

## Testing Strategy

### Validation Approach

Two-phase: first surface counterexamples on unfixed code to confirm the root cause, then verify
the fix and preservation.

### Exploratory Bug Condition Checking

**Goal**: Confirm that `graphNodeToProcess` returns `steps: []` on unfixed code even when
`HAS_STEP` edges exist.

**Test Plan**: Mock a Neo4j session that returns a Process node with known `HAS_STEP` edges.
Call the current `graphNodeToProcess` and assert `steps.length > 0` — this will FAIL on
unfixed code, confirming the bug.

**Test Cases**:
1. **Single process, 3 steps**: Mock session with 3 `HAS_STEP` edges → assert `steps.length === 3` (fails on unfixed code)
2. **MCP totalSteps**: Call `executeContextRetrieval` with mocked session → assert `processes[0].steps.length > 0` (fails on unfixed code)
3. **Order preservation**: Assert steps are sorted by `order` ASC (fails on unfixed code — no steps returned)
4. **Zero steps edge case**: Process with no `HAS_STEP` edges → assert `steps.length === 0` (passes on both unfixed and fixed)

**Expected Counterexamples**:
- `steps` is always `[]` regardless of mocked `HAS_STEP` edges
- Root cause confirmed: `graphNodeToProcess` never queries the session

### Fix Checking

**Goal**: Verify that for all Process nodes, the fixed function returns steps matching the graph.

**Pseudocode:**
```
FOR ALL processNode WHERE isBugCondition(processNode) DO
  result ← graphNodeToProcess_fixed(processNode, session)
  stepCount ← COUNT HAS_STEP edges for processNode.id in session
  ASSERT result.steps.length = stepCount
  ASSERT FOR ALL i IN [0, stepCount-1]: result.steps[i].order = i
END FOR
```

### Preservation Checking

**Goal**: Verify that all non-process fields are identical before and after the fix.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT executeQuery_original(input).symbols   = executeQuery_fixed(input).symbols
  ASSERT executeQuery_original(input).clusters  = executeQuery_fixed(input).clusters
  ASSERT executeQuery_original(input).riskLevel = executeQuery_fixed(input).riskLevel
  ASSERT executeQuery_original(input).confidence = executeQuery_fixed(input).confidence
END FOR
```

**Testing Approach**: Property-based testing with `fast-check` generates random symbol names,
file paths, and step counts to verify preservation across many inputs.

**Test Cases**:
1. **Symbol fields preserved**: Random symbol inputs → symbols array identical before/after fix
2. **Cluster fields preserved**: Random cluster inputs → clusters array identical before/after fix
3. **Risk level preserved**: Random dependent counts → riskLevel identical before/after fix
4. **Empty process preservation**: Target with no processes → `processes: []` in both versions

### Unit Tests

- `findProcessSteps` returns empty array when no `HAS_STEP` edges exist
- `findProcessSteps` returns steps ordered by `order` ASC
- `graphNodeToProcess` in `process-helpers.ts` calls `findProcessSteps` with correct process ID
- Each query file no longer defines a local `graphNodeToProcess`

### Property-Based Tests

- For any process with N steps (N ∈ [0, 20]), `steps.length === N` after fix (Property 1)
- For any query input, non-process fields are identical before and after fix (Property 2)
- For any process, `steps[i].order === i` for all i (ordering invariant from data model)

### Integration Tests

- `executeContextRetrieval` returns correct `totalSteps` in MCP response for a seeded graph
- `executeImpactAnalysis` returns correct `totalSteps` for all affected processes
- `executePreCommitCheck` returns correct `totalSteps` for processes in changed files
- `smart-search.ts` behavior is unchanged (steps still fetched via `p.steps` node property)
