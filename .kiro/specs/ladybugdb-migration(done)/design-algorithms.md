# Design: Algorithmic Pseudocode & Formal Specifications

## Key Functions with Formal Specifications

### Function 1: LadybugDB `semanticSearch()`

```typescript
async function semanticSearch(
  db: LadybugDatabase, queryEmbedding: Embedding,
  limit: number, prefix: string,
): Promise<SearchResult[]>
```

**Preconditions:** `db` connected, `queryEmbedding.vector.length === queryEmbedding.dimensions`, `limit > 0`, `prefix` valid.
**Postconditions:** Returns `SearchResult[]` with `length <= limit`, all `score >= 0.70`, ordered descending. Empty if no embeddings exist.

### Function 2: Ollama `embedText()`

```typescript
async function embedText(text: string, config: OllamaConfig): Promise<Embedding | null>
```

**Preconditions:** `config.enabled === true`, `config.url` valid HTTP, `text` non-empty.
**Postconditions:** Returns `Embedding` with `vector.length === config.dimensions`, or `null` on error. Privacy: no source code in `text`.

### Function 3: `createDatabaseAdapter()`

```typescript
async function createDatabaseAdapter(config: FullConfig): Promise<DatabaseAdapter>
```

**Preconditions:** `config.prefix` validated, `config.ladybugdb.dbPath` resolved (from `LADYBUGDB_PATH` or `~/.typocop/{prefix}/db.ladybug`), parent directory exists or is auto-created.
**Postconditions:** Returns initialized `DatabaseAdapter`. LadybugDB file exists, embeddings table created, adapters ready.

## Algorithmic Pseudocode

### Query Execution via Adapter

```typescript
async function executeQuery(query: Query, adapter: DatabaseAdapter): Promise<QueryResult> {
  const graph = adapter.getGraphAdapter();
  const vector = adapter.getVectorAdapter();
  const embedder = adapter.getEmbeddingAdapter();
  const processedText = preprocessQuery(sanitizeQuery(query.text));
  const { intent } = parseQueryIntent(processedText);

  if (intent.type === "smartSearch" && embedder.isEnabled()) {
    const embedding = await embedder.embedText(processedText);
    if (embedding) {
      const results = await vector.semanticSearch(embedding, query.maxResults);
      const symbolIds = results.map(r => r.symbolId);
      const symbols = await graph.runCypher<Symbol>(
        "MATCH (s:Symbol) WHERE s.id IN $ids RETURN s", { ids: symbolIds }
      );
      // ... build QueryResult from symbols, clusters, processes
    }
  }
  if (intent.type === "impactAnalysis") {
    return graph.runCypher(impactCypherQuery, { target: intent.target });
  }
  // ... other intent types use graph adapter only
}
```

### Embedding Generation with Ollama

```typescript
async function ollamaEmbedText(text: string, config: OllamaConfig): Promise<Embedding | null> {
  try {
    const response = await fetch(`${config.url}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, prompt: text }),
    });
    if (!response.ok) { console.warn(`[ollama] HTTP ${response.status}`); return null; }
    const data = await response.json();
    const vector: number[] = data.embedding;
    if (vector.length !== config.dimensions) {
      console.warn(`[ollama] Dimension mismatch: ${vector.length} vs ${config.dimensions}`);
      return null;
    }
    return { vector, dimensions: config.dimensions };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ollama] Unavailable: ${msg}`);
    return null;
  }
}
```

### LadybugDB Vector Search

```typescript
async function ladybugSemanticSearch(
  db: LadybugDatabase, queryEmbedding: Embedding,
  limit: number, prefix: string,
): Promise<SearchResult[]> {
  const table = `${prefix}embeddings`;
  const result = await db.sql(
    `SELECT symbol_id, metadata, vector_search(embedding, ?, ?) AS score
     FROM ${table} WHERE score >= ? ORDER BY score DESC LIMIT ?`,
    [JSON.stringify(queryEmbedding.vector), queryEmbedding.dimensions,
     SEMANTIC_SEARCH_THRESHOLD, limit],
  );
  return result.rows.map(row => ({
    symbolId: row.symbol_id as string,
    score: row.score as number,
    metadata: JSON.parse(row.metadata as string) as Record<string, string>,
  }));
}
```
