# Multi-Tenancy Prefix Support Design

## Overview

Two separate bugs prevent multi-tenancy in Typocop:

1. **Neo4j**: `storeNodes()` and `storeEdges()` in `src/graph/store.ts` write hardcoded unprefixed labels and types. The `GraphStore` class exists with full prefix support but is never used by the indexer pipeline.
2. **PostgreSQL**: `semanticSearch()`, `indexSymbol()`, and `initVectorStore()` use a hardcoded unprefixed `embeddings` table.

The fix threads the prefix from `ConfigurationManager` into both write paths.

## Glossary

- **Bug_Condition (C)**: Two instances with different prefixes share the same database and write/read to unprefixed labels or tables
- **prefix**: String loaded from `TYPOCOP_PREFIX` env var (e.g., `tpc_`, `myapp_`)
- **prefixed label**: `${prefix}${baseLabel}` (e.g., `tpc_Symbol`)
- **prefixed type**: `${prefix}${baseType}` (e.g., `tpc_CALLS`)
- **prefixed table**: `${prefix}embeddings` (e.g., `tpc_embeddings`)

## Bug Condition (Formal)

```
FUNCTION isBugCondition(instance1Prefix, instance2Prefix, sharedDb)
  RETURN instance1Prefix != instance2Prefix AND sharedDb = true
END FUNCTION
```

When this condition holds, both instances read/write to the same unprefixed labels and tables, causing data collisions.

## Root Causes

**Neo4j (src/graph/store.ts)**
- `storeNodes()` uses `n.labels[0]` directly in Cypher — no prefix applied
- `storeEdges()` uses `edge.relType` directly in Cypher — no prefix applied
- `GraphStore` class is fully implemented but never instantiated by the pipeline

**PostgreSQL (src/vector/)**
- `initVectorStore()` hardcodes `embeddings` table and `embeddings_hnsw_idx` index
- `semanticSearch()` hardcodes `FROM embeddings` in SQL
- `indexSymbol()` hardcodes `INSERT INTO embeddings` in SQL

## Fix Design

### Neo4j Fix

**File**: `src/graph/store.ts`

Update `storeNodes()` and `storeEdges()` to accept a `prefix: string` parameter and prepend it to all labels and relationship types:

```typescript
// storeNodes: prepend prefix to each node label
labels: n.labels.map(l => `${prefix}${l}`)

// storeEdges: prepend prefix to relationship type
relType: `${prefix}${edge.relType}`
```

**File**: `src/indexer/pipeline.ts`

Pass `configurationManager.getPrefix()` to `storeNodes()` and `storeEdges()`.

### PostgreSQL Fix

**File**: `src/vector/connection.ts`

Add `prefix: string` to `initVectorStore()`:
```typescript
const table = `${prefix}embeddings`
const index = `${prefix}embeddings_hnsw_idx`
```

**File**: `src/vector/search.ts`

Add `prefix: string` to `semanticSearch()`:
```typescript
FROM ${prefix}embeddings
```

**File**: `src/vector/index-store.ts`

Add `prefix: string` to `indexSymbol()`:
```typescript
INSERT INTO ${prefix}embeddings
```

### Caller Updates

All callers of the above functions must pass `configurationManager.getPrefix()`:
- `src/indexer/pipeline.ts` — calls `storeNodes`, `storeEdges`, `indexSymbol`, `initVectorStore`
- `src/query/server.ts` — calls `semanticSearch`

## Correctness Properties

**Property 1: Neo4j Multi-Instance Isolation**
_For any_ two instances with different prefixes sharing Neo4j, nodes and relationships written by instance 1 SHALL use labels/types prefixed with instance 1's prefix, completely isolated from instance 2's data.
_Validates: Requirements 2.1, 2.2, 2.3_

**Property 2: PostgreSQL Multi-Instance Isolation**
_For any_ two instances with different prefixes sharing PostgreSQL, embeddings written by instance 1 SHALL be stored in and read from instance 1's prefixed table, completely isolated from instance 2's data.
_Validates: Requirements 2.4, 2.5, 2.6_

**Property 3: Preservation — Single-Instance Behavior**
_For any_ single instance with default prefix `tpc_`, all indexing and query results SHALL be identical before and after the fix.
_Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

## Testing Strategy

**Exploration tests (must FAIL on unfixed code):**
- Two instances with different prefixes index the same symbol ID into Neo4j — verify instance 1 reads instance 2's node (proves Neo4j bug)
- Two instances with different prefixes index the same symbol ID into PostgreSQL — verify instance 1 reads instance 2's embedding (proves PG bug)

**Fix validation tests (must PASS after fix):**
- Re-run exploration tests — they should now pass with isolated prefixed data

**Preservation tests (must PASS on both unfixed and fixed code):**
- Single instance with `tpc_` prefix: verify Neo4j and PostgreSQL results are identical before and after fix
