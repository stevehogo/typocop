# Cluster/Process Edge Bug — Bugfix Design

## Overview

The indexer pipeline in `src/indexer/pipeline.ts` emits cluster and process membership edges
with the wrong relationship type and reversed direction. The graph queries `findClustersBySymbol`
and `findProcessesBySymbol` expect `(Cluster)-[:CONTAINS]->(Symbol)` and
`(Process)-[:HAS_STEP]->(Symbol)` respectively, but the pipeline writes the inverse. The fix
is a targeted two-block change inside `buildGraph` — no other files need to change.

## Glossary

- **Bug_Condition (C)**: An edge emitted by `buildGraph` where `relType` is `"BELONGS_TO"` or
  `"PART_OF"` (the wrong types), or where source/target are reversed relative to the query contract
- **Property (P)**: Every cluster edge SHALL be `(cluster)-[:CONTAINS]->(symbol)` and every
  process edge SHALL be `(process)-[:HAS_STEP]->(symbol)`
- **Preservation**: All `relationshipEdges` (CALLS, IMPORTS, INHERITS, etc.), all node writes,
  and all other pipeline behaviour must remain byte-for-byte identical after the fix
- **`buildGraph`**: The exported function in `src/indexer/pipeline.ts` that converts analysis
  output into graph nodes and edges and persists them via `storeNodes` / `storeEdges`
- **`clusterEdges`**: The `GraphEdge[]` array built from `clusters[].symbols` — currently wrong
- **`processEdges`**: The `GraphEdge[]` array built from `processes[].steps` — currently wrong

## Bug Details

### Bug Condition

The bug manifests whenever `buildGraph` is called with at least one cluster or process. The
`clusterEdges` and `processEdges` construction blocks use the symbol as the source and the
aggregate node (cluster/process) as the target, which is the opposite of what the Cypher
queries in `query.ts` expect.

**Formal Specification:**
```
FUNCTION isBugCondition(edge)
  INPUT: edge of type GraphEdge
  OUTPUT: boolean

  RETURN (edge.relType = "BELONGS_TO")
      OR (edge.relType = "PART_OF")
      OR (edge.relType = "CONTAINS"  AND edge.source is a Symbol ID)
      OR (edge.relType = "HAS_STEP"  AND edge.source is a Symbol ID)
END FUNCTION
```

### Examples

- Cluster `auth-cluster` contains symbol `UserService.login`:
  - Current (buggy): `(UserService.login)-[:BELONGS_TO]->(auth-cluster)`
  - Expected: `(auth-cluster)-[:CONTAINS]->(UserService.login)`

- Process `login-flow` has step `UserService.login` at order 0:
  - Current (buggy): `(UserService.login)-[:PART_OF]->(login-flow)`
  - Expected: `(login-flow)-[:HAS_STEP]->(UserService.login)` with `{ order: "0" }`

- Symbol with no cluster membership — no cluster edge emitted (unaffected by fix)

- Process step with `order: 2` — `order` property must still be `"2"` after fix

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `relationshipEdges` (CALLS, IMPORTS, INHERITS, IMPLEMENTS, etc.) must be stored with their
  original `source`, `target`, and `relType` values — the fix must not touch this array
- Cluster and process node properties (`name`, `category`, `confidence`, `stepCount`, etc.)
  must continue to be written correctly — the fix only touches edge construction
- Symbol nodes must continue to be written correctly
- The `order` property on process step edges must still be set to `String(step.order)`

**Scope:**
All inputs that do NOT produce cluster or process edges are completely unaffected. This includes:
- Any call to `buildGraph` with empty `clusters` and `processes` arrays
- All `relationshipEdges` regardless of their `relType`
- All node writes (`storeNodes`)

## Hypothesized Root Cause

1. **Copy-paste from relationship edges**: The `clusterEdges` and `processEdges` blocks were
   likely written by analogy with `relationshipEdges`, where `source → target` means "the
   symbol points to something". For membership edges the semantic is inverted — the container
   points to its members.

2. **Mismatch with query contract**: `findClustersBySymbol` and `findProcessesBySymbol` in
   `query.ts` were written with the correct direction (`(Cluster)-[:CONTAINS]->(s)`,
   `(Process)-[:HAS_STEP]->(s)`) but the pipeline was never updated to match.

3. **No integration test at write time**: Because the pipeline and query layers are tested
   independently, the direction mismatch was not caught until the MCP tool returned empty arrays.

## Correctness Properties

Property 1: Bug Condition — Cluster Edges Have Correct Type and Direction

_For any_ cluster with at least one symbol, the fixed `buildGraph` function SHALL emit edges
where `source` is the cluster ID, `target` is the symbol ID, and `relType` is `"CONTAINS"`.
No edge with `relType` `"BELONGS_TO"` shall be emitted.

**Validates: Requirements 2.1, 2.3**

Property 2: Bug Condition — Process Edges Have Correct Type and Direction

_For any_ process with at least one step, the fixed `buildGraph` function SHALL emit edges
where `source` is the process ID, `target` is the step's symbol ID, `relType` is `"HAS_STEP"`,
and the `order` property equals `String(step.order)`.
No edge with `relType` `"PART_OF"` shall be emitted.

**Validates: Requirements 2.2, 2.4**

Property 3: Preservation — Relationship Edges Are Unchanged

_For any_ input where the bug condition does NOT hold (i.e. the edge comes from
`relationshipEdges`), the fixed `buildGraph` function SHALL produce the same `source`,
`target`, and `relType` as the original function, preserving all symbol-to-symbol relationships.

**Validates: Requirements 3.1, 3.3, 3.4, 3.6**

## Fix Implementation

### Changes Required

**File**: `src/indexer/pipeline.ts`

**Function**: `buildGraph` (cluster and process edge construction blocks, ~lines 280–295)

**Specific Changes**:

1. **`clusterEdges` — swap source/target, rename relType**:
   ```typescript
   // Before (buggy)
   const clusterEdges: GraphEdge[] = clusters.flatMap((c) =>
     c.symbols.map((symbolId) => ({
       source: symbolId,
       target: c.id,
       relType: "BELONGS_TO",
       properties: {},
     }))
   );

   // After (fixed)
   const clusterEdges: GraphEdge[] = clusters.flatMap((c) =>
     c.symbols.map((symbolId) => ({
       source: c.id,
       target: symbolId,
       relType: "CONTAINS",
       properties: {},
     }))
   );
   ```

2. **`processEdges` — swap source/target, rename relType**:
   ```typescript
   // Before (buggy)
   const processEdges: GraphEdge[] = processes.flatMap((p) =>
     p.steps.map((step) => ({
       source: step.symbolId,
       target: p.id,
       relType: "PART_OF",
       properties: { order: String(step.order) },
     }))
   );

   // After (fixed)
   const processEdges: GraphEdge[] = processes.flatMap((p) =>
     p.steps.map((step) => ({
       source: p.id,
       target: step.symbolId,
       relType: "HAS_STEP",
       properties: { order: String(step.order) },
     }))
   );
   ```

No other files require changes.

## Testing Strategy

### Validation Approach

Two-phase: first run exploratory tests against the unfixed code to confirm the root cause,
then verify the fix satisfies both correctness properties and all preservation properties.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples on unfixed code to confirm the direction/type mismatch.

**Test Plan**: Call the edge-building logic directly (or mock `storeEdges` to capture emitted
edges) and assert the expected `relType` and direction. These assertions will fail on unfixed
code, confirming the root cause.

**Test Cases**:
1. **Cluster edge type check**: Build edges for a cluster with 2 symbols — assert `relType === "CONTAINS"` (fails on unfixed code, returns `"BELONGS_TO"`)
2. **Cluster edge direction check**: Assert `edge.source === cluster.id` (fails on unfixed code, source is symbolId)
3. **Process edge type check**: Build edges for a process with 2 steps — assert `relType === "HAS_STEP"` (fails on unfixed code, returns `"PART_OF"`)
4. **Process edge direction check**: Assert `edge.source === process.id` (fails on unfixed code, source is step.symbolId)

**Expected Counterexamples**:
- `edge.relType` is `"BELONGS_TO"` instead of `"CONTAINS"`
- `edge.source` is a symbol ID instead of a cluster ID
- `edge.relType` is `"PART_OF"` instead of `"HAS_STEP"`
- `edge.source` is a symbol ID instead of a process ID

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces
the expected edges.

**Pseudocode:**
```
FOR ALL cluster WHERE cluster.symbols.length > 0 DO
  edges := buildClusterEdges(cluster)
  FOR ALL edge IN edges DO
    ASSERT edge.relType = "CONTAINS"
    ASSERT edge.source = cluster.id
    ASSERT edge.target IN cluster.symbols
  END FOR
END FOR

FOR ALL process WHERE process.steps.length > 0 DO
  edges := buildProcessEdges(process)
  FOR ALL edge IN edges DO
    ASSERT edge.relType = "HAS_STEP"
    ASSERT edge.source = process.id
    ASSERT edge.target = step.symbolId
    ASSERT edge.properties.order = String(step.order)
  END FOR
END FOR
```

### Preservation Checking

**Goal**: Verify that relationship edges and node writes are completely unaffected by the fix.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT buildGraph_original(input).relationshipEdges
       = buildGraph_fixed(input).relationshipEdges
END FOR
```

**Testing Approach**: Property-based testing with `fast-check` is used for preservation because:
- It generates many random relationship arrays and verifies pass-through is exact
- It catches any accidental mutation of the `relationshipEdges` array
- It provides strong guarantees across the full input domain

**Test Cases**:
1. **Relationship edge pass-through**: Generate random `Relationship[]`, assert emitted edges match exactly
2. **Empty clusters/processes**: Assert no cluster or process edges are emitted when arrays are empty
3. **Order property preservation**: Generate processes with random step orders, assert `order` property is preserved

### Unit Tests

- Test `clusterEdges` construction: correct `source`, `target`, `relType` for single and multi-symbol clusters
- Test `processEdges` construction: correct `source`, `target`, `relType`, and `order` for single and multi-step processes
- Test empty cluster/process arrays produce no edges
- Test that `relationshipEdges` array is passed through unchanged

### Property-Based Tests

- Generate arbitrary `Cluster[]` via `fast-check`, assert every emitted cluster edge satisfies Property 1
- Generate arbitrary `Process[]` via `fast-check`, assert every emitted process edge satisfies Property 2
- Generate arbitrary `Relationship[]` via `fast-check`, assert emitted relationship edges are identical (Property 3)

### Integration Tests

- Index a minimal fixture with one cluster and one process, then call `findClustersBySymbol` and `findProcessesBySymbol` — assert non-empty results
- Verify `get_symbol_context` MCP tool returns non-empty `clusters` and `processes` for a symbol that belongs to both
