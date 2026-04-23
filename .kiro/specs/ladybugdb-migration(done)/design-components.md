# Design: Components and Interfaces

## Component 1: GraphAdapter

**Purpose**: Abstracts graph database operations (node/relationship CRUD, Cypher queries) behind a common interface so the query layer and indexer are decoupled from the underlying database engine.

```typescript
interface GraphAdapter {
  createNode(label: string, properties: Record<string, unknown>): Promise<void>;
  createRelationship(
    fromId: string, toId: string, type: string,
    properties?: Record<string, unknown>,
  ): Promise<void>;
  queryNodes(label: string, filter?: Record<string, unknown>): Promise<GraphNode[]>;
  queryRelationships(type: string): Promise<GraphRelationship[]>;
  deleteNodesByLabel(label: string): Promise<void>;
  deleteRelationshipsByType(type: string): Promise<void>;
  runCypher<T>(query: string, params?: Record<string, unknown>): Promise<T[]>;
  runCypherWrite(query: string, params?: Record<string, unknown>): Promise<void>;
}
```

**Responsibilities**:
- Prefix-aware label/type management (delegates to internal prefix logic)
- Cypher query execution (LadybugDB auto-transpiles to SQL)
- Transaction management via LadybugDB sessions
- Read/write separation for query optimization

## Component 2: VectorAdapter

**Purpose**: Abstracts vector storage and semantic search operations.

```typescript
interface VectorAdapter {
  createTables(): Promise<void>;
  indexSymbol(
    symbolId: string, embedding: Embedding,
    metadata?: Record<string, string>,
  ): Promise<void>;
  semanticSearch(queryEmbedding: Embedding, limit: number): Promise<SearchResult[]>;
  deleteAll(): Promise<void>;
}
```

**Responsibilities**:
- Embedding storage with UPSERT semantics
- ANN search via LadybugDB's `vector_search()` function
- Prefix-aware table naming
- Score threshold filtering (≥ 0.70)

## Component 3: EmbeddingAdapter

**Purpose**: Pluggable embedding generation — Ollama when enabled, NoOp when disabled.

```typescript
interface EmbeddingAdapter {
  isEnabled(): boolean;
  embedText(text: string): Promise<Embedding | null>;
  getDimensions(): number;
}
```

**Responsibilities**:
- `OllamaEmbeddingAdapter`: Calls local Ollama HTTP API for embeddings
- `NoOpEmbeddingAdapter`: Returns `null` (embeddings disabled, default)
- Dimension reporting for table schema creation

## Component 4: DatabaseAdapter (Facade)

**Purpose**: Unified entry point combining graph, vector, and embedding adapters.

```typescript
interface DatabaseAdapter {
  initialize(): Promise<void>;
  close(): Promise<void>;
  getGraphAdapter(): GraphAdapter;
  getVectorAdapter(): VectorAdapter;
  getEmbeddingAdapter(): EmbeddingAdapter;
}
```

**Responsibilities**:
- LadybugDB connection lifecycle management
- Adapter instantiation and wiring
- Retry logic with exponential backoff on connection

## Component 5: LadybugDB Connection Manager

**Purpose**: Manages the LadybugDB driver and SQL connection.

```typescript
interface LadybugConnection {
  readonly driver: LadybugDriver;    // For Cypher (graph) queries
  readonly db: LadybugDatabase;      // For SQL (vector/analytics) queries
  readonly dbPath: string;
  close(): Promise<void>;
}
```

**Responsibilities**:
- File-based database initialization at configured path
- Driver creation with `GraphDatabase.driver("ladybug://" + path)`
- SQL connection via `connect(path)`
- Schema initialization (embeddings table, indexes)

## Component 6: ConfigurationManager Extensions

**Purpose**: Extend existing `ConfigurationManager` with Ollama and LadybugDB config.

```typescript
interface OllamaConfig {
  readonly enabled: boolean;       // OLLAMA_ENABLED, default: false
  readonly url: string;            // OLLAMA_URL, default: "http://localhost:11434"
  readonly model: string;          // OLLAMA_MODEL, default: "qwen3-embedding:4b"
  readonly dimensions: number;     // OLLAMA_DIMENSIONS, default: 2560
}

interface LadybugDBConfig {
  readonly dbPath: string;         // LADYBUGDB_PATH or default: "~/.typocop/{prefix}/db.ladybug"
}

interface ExtendedConfiguration {
  readonly prefix: string;
  readonly ollama: OllamaConfig;
  readonly ladybugdb: LadybugDBConfig;
}
```

**Responsibilities**:
- Load and validate Ollama env vars (all optional, off by default)
- Load and validate LadybugDB path
- Expose typed config to adapter factory

## Component 7: Semantic Cluster Classifier

**Purpose**: Uses Ollama embeddings to semantically classify clusters into categories, reducing `"unknown"` clusters.

```typescript
interface SemanticClusterClassifier {
  initialize(embedder: EmbeddingAdapter): Promise<void>;
  classify(clusterText: string): Promise<ClusterCategory>;
}
```

**Responsibilities**:
- Generate and cache category reference embeddings (one per `ClusterCategory`) on first call
- Aggregate cluster symbol metadata into a text representation
- Compute cosine similarity between cluster embedding and each category embedding
- Return highest-scoring category above threshold (≥ 0.50), or `"unknown"`
- Falls back to keyword-based `classifyCluster()` when `EmbeddingAdapter.isEnabled()` is false
