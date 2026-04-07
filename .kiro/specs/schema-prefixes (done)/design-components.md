# Components & Interfaces: Schema Prefixes

Part of the [Schema Prefixes Design](./design.md).

## Configuration Manager

**Responsibility:** Load, validate, and propagate the single prefix to all database modules.

```typescript
interface IConfigurationManager {
  // Load and validate prefix from environment
  initialize(): Promise<void>;
  
  // Get validated prefix (applies to both PG and Neo4j)
  getPrefix(): string;
  
  // Validate a prefix
  validate(prefix: string): ValidationResult;
  
  // Get current configuration for debugging
  getConfiguration(): PrefixConfiguration;
}

interface PrefixConfiguration {
  prefix: string;           // effective prefix (default: 'tpc_')
  loadedAt: Date;
  source: 'environment' | 'env-file' | 'default';
}

interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
  normalized?: string;
}
```

## Prefix Validator

**Responsibility:** Validate prefix against unified naming rules (compatible with both PostgreSQL and Neo4j).

```typescript
interface IPrefixValidator {
  // Validate prefix (unified rules for both databases)
  validate(prefix: string): ValidationResult;
  
  // Normalize prefix (append underscore if needed)
  normalize(prefix: string): string;
}

// Unified Rules (satisfies both PostgreSQL and Neo4j):
// - Pattern: ^[a-z][a-z0-9_]*$
// - Must start with lowercase letter
// - Max length: 32 characters
// - Auto-append underscore if missing
// - Reject uppercase, special chars, hyphens, dots, spaces
// - Empty string allowed (disables prefixing)
```

## Vector Store (PostgreSQL)

**Responsibility:** Use prefixed table names in all database operations.

```typescript
interface IVectorStore {
  // Constructor receives prefix
  constructor(prefix: string);
  
  // Get prefixed table name
  getTableName(baseName: 'embeddings' | 'metadata'): string;
  
  // All query methods use prefixed names internally
  createTables(): Promise<void>;
  insertEmbedding(data: EmbeddingData): Promise<void>;
  queryByVector(vector: number[]): Promise<SearchResult[]>;
  updateMetadata(id: string, metadata: Record<string, any>): Promise<void>;
  deleteByPrefix(prefix: string): Promise<void>;
}
```

**Implementation Details:**
- Store prefix as instance property
- Concatenate prefix + table name in all SQL statements
- CREATE TABLE, SELECT, INSERT, UPDATE, DELETE all use prefixed names
- CREATE INDEX statements use prefixed table names
- Empty prefix → use base table names

## Graph Store (Neo4j)

**Responsibility:** Use prefixed node labels and relationship types in all operations.

```typescript
interface IGraphStore {
  // Constructor receives prefix
  constructor(prefix: string);
  
  // Get prefixed label
  getLabel(baseLabel: string): string;
  
  // Get prefixed relationship type
  getRelationType(baseType: string): string;
  
  // All query methods use prefixed names internally
  createNode(label: string, properties: Record<string, any>): Promise<void>;
  createRelationship(
    fromId: string,
    toId: string,
    type: string,
    properties?: Record<string, any>
  ): Promise<void>;
  queryNodes(label: string, filter?: Record<string, any>): Promise<Node[]>;
  queryRelationships(type: string): Promise<Relationship[]>;
  deleteNodesByLabel(label: string): Promise<void>;
}
```

**Implementation Details:**
- Store prefix as instance property
- Concatenate prefix + label in all MATCH/MERGE/CREATE statements
- Concatenate prefix + type in all relationship operations
- Empty prefix → use base labels and types

## Query Builders

**Cypher Query Builder:**
```typescript
interface ICypherQueryBuilder {
  constructor(prefix: string);
  
  // Build MATCH query with prefixed labels
  match(label: string, alias: string): ICypherQueryBuilder;
  
  // Build relationship with prefixed type
  relationship(type: string, direction: 'in' | 'out'): ICypherQueryBuilder;
  
  // Build MERGE with prefixed labels
  merge(label: string, properties: Record<string, any>): ICypherQueryBuilder;
  
  // Build CREATE with prefixed labels
  create(label: string, properties: Record<string, any>): ICypherQueryBuilder;
  
  // Get current prefix
  getPrefix(): string;
  
  // Build final query string
  build(): string;
}
```

**SQL Query Builder:**
```typescript
interface ISqlQueryBuilder {
  constructor(prefix: string);
  
  // Build SELECT with prefixed table
  select(columns: string[], table: string): ISqlQueryBuilder;
  
  // Build INSERT with prefixed table
  insert(table: string, values: Record<string, any>): ISqlQueryBuilder;
  
  // Build UPDATE with prefixed table
  update(table: string, values: Record<string, any>): ISqlQueryBuilder;
  
  // Build DELETE with prefixed table
  delete(table: string): ISqlQueryBuilder;
  
  // Get current prefix
  getPrefix(): string;
  
  // Build final query string
  build(): string;
}
```

## Error Types

```typescript
class ConfigurationError extends Error {
  constructor(
    message: string,
    public prefix: string,
    public reason: string,
    public suggestion?: string
  ) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

class PrefixValidationError extends ConfigurationError {
  constructor(prefix: string, reason: string, suggestion?: string) {
    super(
      `Invalid prefix: ${prefix}. ${reason}${suggestion ? ` Suggestion: ${suggestion}` : ''}`,
      prefix,
      reason,
      suggestion
    );
    this.name = 'PrefixValidationError';
  }
}
```

## Integration Points

**CLI Integration:**
- Configuration_Manager initialized at CLI startup
- Single prefix passed to both Vector_Store and Graph_Store
- Status commands use configured prefix

**Query Server Integration:**
- Configuration_Manager initialized at server startup
- Single prefix passed to both Graph_Store and Vector_Store
- Response labels/types stripped of prefix before returning to clients

**MCP Server Integration:**
- Inherits Configuration_Manager from Query Server
- All MCP tools use configured prefix
- Tool responses strip prefix from labels/types
