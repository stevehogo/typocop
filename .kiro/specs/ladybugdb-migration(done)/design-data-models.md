# Design: Data Models

## Updated Embedding Type

The `Embedding` type must support variable dimensions since Ollama models produce different sizes than OpenAI (e.g., `qwen3-embedding:4b` = 2560 dims vs OpenAI's 1536).

```typescript
// Updated in src/types/index.ts
interface Embedding {
  readonly vector: number[];     // length === dimensions
  readonly dimensions: number;   // variable: 2560 (Ollama qwen3-embedding:4b) or other
}
```

**Validation**: `vector.length === dimensions` must always hold. The fixed 1536 constraint is removed.

## Configuration Types

```typescript
// New in src/config/types.ts
interface OllamaConfig {
  readonly enabled: boolean;
  readonly url: string;
  readonly model: string;
  readonly dimensions: number;
}

interface LadybugDBConfig {
  readonly dbPath: string;
}

interface FullConfig {
  readonly prefix: string;
  readonly ollama: OllamaConfig;
  readonly ladybugdb: LadybugDBConfig;
  readonly loadedAt: Date;
  readonly source: "environment" | "env-file" | "default";
}
```

## Environment Variables

```bash
# LadybugDB (replaces NEO4J_* and POSTGRES_*)
# Optional: override database path. Default: ~/.typocop/{prefix}/db.ladybug
# LADYBUGDB_PATH=/custom/path/db.ladybug

# Ollama embeddings (replaces OPENAI_API_KEY) — all optional
OLLAMA_ENABLED=false          # default: false (embeddings disabled)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen3-embedding:4b
OLLAMA_DIMENSIONS=2560

# Retained
TYPOCOP_PREFIX=tpc_
```

## Schema Mapping: Neo4j → LadybugDB

LadybugDB's Cypher interface auto-transpiles to SQL. Node labels and relationship types map directly:

| Neo4j Concept | LadybugDB Equivalent | Notes |
|---|---|---|
| Node label `tpc_Symbol` | Same Cypher label | Auto-transpiled to SQL table |
| Relationship `:tpc_CALLS` | Same Cypher type | Auto-transpiled to SQL join |
| `MERGE (n:Label {id: $id})` | Same Cypher syntax | Drop-in compatible |
| `MATCH (n)-[r:TYPE]->(m)` | Same Cypher syntax | Drop-in compatible |
| Neo4j Session | LadybugDB Session | Compatible API |

## Schema Mapping: PostgreSQL → LadybugDB

| PostgreSQL Concept | LadybugDB Equivalent | Notes |
|---|---|---|
| `vector(1536)` column | Variable-dimension vector column | No dimension limit |
| `<=>` cosine distance | `vector_search()` function | Different syntax |
| HNSW index | LanceDB ANN (HNSW/IVF) | Built-in, no extension |
| `pg` Pool | `db.sql()` interface | Simpler API |

## LadybugDB Embeddings Table Schema

```sql
CREATE TABLE IF NOT EXISTS {prefix}embeddings (
  symbol_id TEXT PRIMARY KEY,
  embedding FLOAT[],           -- variable dimensions
  dimensions INTEGER NOT NULL,
  metadata JSON DEFAULT '{}'
);
```

## GraphNode / GraphRelationship (Adapter Types)

```typescript
// Shared adapter types in src/db/types.ts
interface GraphNode {
  readonly id: string;
  readonly labels: string[];
  readonly properties: Record<string, unknown>;
}

interface GraphRelationship {
  readonly type: string;
  readonly properties: Record<string, unknown>;
  readonly sourceId?: string;
  readonly targetId?: string;
}
```

These replace the Neo4j-specific `GraphNode` from `src/graph/connection.ts` and are database-agnostic.
