# Bugfix Requirements Document

## Introduction

`totalSteps` is always `0` in MCP tool responses for all process objects. The root cause is that
`graphNodeToProcess()` in the query layer hardcodes `steps: []` — it never fetches `HAS_STEP` edges
from Neo4j. This affects three query files: `src/query/context-retrieval.ts`,
`src/query/impact-analysis.ts`, and `src/query/pre-commit-check.ts`. As a result,
`src/mcp/tools.ts` line 49 (`totalSteps: p.steps.length`) always evaluates to `0`, giving AI
editors no useful process step information.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a Process node is fetched from Neo4j and converted via `graphNodeToProcess()` THEN the
    system returns `steps: []` unconditionally, ignoring any `HAS_STEP` edges in the graph

1.2 WHEN `formatMCPResponse()` in `src/mcp/tools.ts` maps a process to the MCP response shape
    THEN the system computes `totalSteps: p.steps.length` which always evaluates to `0`

1.3 WHEN any MCP tool (`get_symbol_context`, `find_dependents`, `trace_data_flow`,
    `impact_analysis`) returns processes THEN the system reports `totalSteps: 0` for every
    process regardless of how many steps are stored in Neo4j

### Expected Behavior (Correct)

2.1 WHEN a Process node is fetched from Neo4j and converted via `graphNodeToProcess()` THEN the
    system SHALL populate `steps` by querying `HAS_STEP` edges ordered by the `order` property,
    returning a `ProcessStep[]` that reflects the actual steps stored in the graph

2.2 WHEN `formatMCPResponse()` maps a process to the MCP response shape THEN the system SHALL
    compute `totalSteps: p.steps.length` equal to the actual number of `HAS_STEP` edges for that
    process (matching the `stepCount` property stored on the Process node)

2.3 WHEN any MCP tool returns processes THEN the system SHALL report `totalSteps` equal to the
    count of `HAS_STEP` edges for each process as confirmed by Neo4j

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a Process node has no `HAS_STEP` edges in Neo4j THEN the system SHALL CONTINUE TO
    return `steps: []` and `totalSteps: 0` for that process

3.2 WHEN `findProcessesBySymbol()` is called THEN the system SHALL CONTINUE TO return the same
    set of Process nodes it returned before this fix (only step population changes, not process
    discovery)

3.3 WHEN any MCP tool returns symbols, clusters, confidence, riskLevel, affectedFlows, or summary
    THEN the system SHALL CONTINUE TO compute and return those fields with identical logic and
    values as before this fix

3.4 WHEN `executeImpactAnalysis()`, `executeContextRetrieval()`, or `executePreCommitCheck()` is
    called with a target that resolves to no processes THEN the system SHALL CONTINUE TO return
    `processes: []` unchanged

---

## Bug Condition Pseudocode

**Bug Condition Function** — identifies inputs that trigger the bug:

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type GraphNode with label "Process"
  OUTPUT: boolean

  // Bug triggers whenever a Process node is converted to a Process object
  // because graphNodeToProcess always returns steps: []
  RETURN true  // all Process nodes are affected
END FUNCTION
```

**Property: Fix Checking**

```pascal
FOR ALL X WHERE isBugCondition(X) DO
  result ← graphNodeToProcess'(X, session)
  stepCount ← parseInt(X.properties["stepCount"] ?? "0", 10)
  ASSERT result.steps.length = stepCount
  ASSERT result.steps are ordered by result.steps[i].order ascending
END FOR
```

**Property: Preservation Checking**

```pascal
FOR ALL X WHERE NOT isBugCondition(X) DO
  // Non-process query results (symbols, clusters, relationships) are unaffected
  ASSERT F(X) = F'(X)
END FOR
```
