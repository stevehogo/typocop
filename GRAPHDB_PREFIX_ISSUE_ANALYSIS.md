# GraphDB Prefix Issue Analysis

## The Real Problem

The `GraphStore` class exists and has full prefix support, but **it is never used** by the indexer pipeline. The actual code that writes to Neo4j uses unprefixed functions.

## Current Architecture

### What Exists (But Unused)
- **`src/graph/graph-store.ts`** — `GraphStore` class with full prefix support
  - `getLabel(baseLabel)` → prepends prefix
  - `getRelationType(baseType)` → prepends prefix
  - `createNode()`, `createRelationship()`, `queryNodes()`, etc. — all use prefixed labels/types
  - **Status**: Fully implemented, tested, but **NOT USED**

### What's Actually Used (No Prefix)
- **`src/graph/store.ts`** — Direct Neo4j write functions
  - `storeNodes(session, nodes)` — writes nodes with hardcoded labels (no prefix)
  - `storeEdges(session, edges)` — writes edges with hardcoded relationship types (no prefix)
  - **Status**: Used by indexer pipeline, but **NO PREFIX SUPPORT**

### Call Chain
```
CLI/MCP/Parser
    ↓
src/indexer/pipeline.ts (storeInDatabases)
    ↓
src/graph/store.ts (storeNodes, storeEdges)  ← WRITES TO NEO4J WITHOUT PREFIX
    ↓
Neo4j (unprefixed labels: Symbol, Cluster, Process, File, etc.)
```

## The Bug

When indexing, the pipeline creates nodes with labels like:
- `Symbol` (should be `tpc_Symbol`)
- `Cluster` (should be `tpc_Cluster`)
- `Process` (should be `tpc_Process`)
- `File` (should be `tpc_File`)

And relationships like:
- `CALLS` (should be `tpc_CALLS`)
- `CONTAINS` (should be `tpc_CONTAINS`)
- `HAS_STEP` (should be `tpc_HAS_STEP`)

This means **multiple Typocop instances with different prefixes will collide in Neo4j** just like they do in PostgreSQL.

## Why GraphStore Exists But Isn't Used

The `GraphStore` class was designed for prefix support but the indexer pipeline was never refactored to use it. Instead, the pipeline uses the simpler `storeNodes` and `storeEdges` functions which bypass `GraphStore` entirely.

## The Fix

Replace the unprefixed `storeNodes` and `storeEdges` functions with prefix-aware versions that use `GraphStore`:

### Option 1: Refactor storeNodes/storeEdges to use GraphStore
```typescript
// src/graph/store.ts
export async function storeNodes(
  session: Session,
  nodes: GraphNode[],
  prefix: string  // ADD THIS
): Promise<void> {
  const store = new GraphStore(prefix);
  // Use store.createNode() instead of hardcoded labels
}

export async function storeEdges(
  session: Session,
  edges: GraphEdge[],
  prefix: string  // ADD THIS
): Promise<void> {
  const store = new GraphStore(prefix);
  // Use store.createRelationship() instead of hardcoded types
}
```

### Option 2: Update indexer pipeline to use GraphStore directly
```typescript
// src/indexer/pipeline.ts
const store = new GraphStore(configurationManager.getPrefix());
await store.createNode(graphSession, "Symbol", symbolProperties);
// ... etc
```

## Files That Need Changes

1. **`src/graph/store.ts`** — Add prefix parameter to `storeNodes()` and `storeEdges()`
2. **`src/indexer/pipeline.ts`** — Pass prefix to `storeNodes()` and `storeEdges()`
3. **All callers of storeNodes/storeEdges** — Thread prefix through

## Impact

- **Neo4j**: All nodes and relationships will be prefixed (e.g., `tpc_Symbol`, `tpc_CALLS`)
- **Multi-tenancy**: Multiple Typocop instances can coexist in same Neo4j database
- **Query layer**: Already handles unprefixed queries (matches on `id`/`name` properties, not labels)
- **Backward compatibility**: Existing unprefixed data will need reindexing

## Why Query Layer Doesn't Need Changes

The query functions in `src/graph/query.ts` don't need prefix changes because they:
- Query by `id` and `name` properties (universal across all prefixes)
- Don't filter by node labels or relationship types
- Work correctly regardless of prefix

Example:
```typescript
// This works with any prefix because it matches on id/name, not label
MATCH (n) WHERE n.id = $val OR n.name = $val RETURN n
```

## Summary

The real issue is that **Neo4j indexing doesn't use prefix at all**, not PostgreSQL. The PostgreSQL prefix fix is still needed, but the **primary bug is in Neo4j indexing** where `storeNodes` and `storeEdges` write unprefixed labels and types.

Both need to be fixed for true multi-tenancy support.
