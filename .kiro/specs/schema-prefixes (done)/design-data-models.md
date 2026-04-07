# Data Models & Algorithms: Schema Prefixes

Part of the [Schema Prefixes Design](./design.md).

## PostgreSQL Table Naming

**Base Tables:**
```
embeddings    → {prefix}embeddings
metadata      → {prefix}metadata
```

**Table Structure (unchanged by prefixing):**
```sql
CREATE TABLE {prefix}embeddings (
  id UUID PRIMARY KEY,
  symbol_id UUID NOT NULL,
  embedding vector(3072),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE {prefix}metadata (
  id UUID PRIMARY KEY,
  symbol_id UUID NOT NULL,
  key VARCHAR(255),
  value TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Index Naming:**
```sql
CREATE INDEX idx_{prefix}embeddings_symbol_id 
  ON {prefix}embeddings(symbol_id);

CREATE INDEX idx_{prefix}metadata_symbol_id 
  ON {prefix}metadata(symbol_id);
```

## Neo4j Node Labels

**Base Labels and Prefixing:**
```
Symbol      → {prefix}Symbol
File        → {prefix}File
Cluster     → {prefix}Cluster
Process     → {prefix}Process
Metadata    → {prefix}Metadata
```

**Node Properties (unchanged by prefixing):**
```cypher
// Symbol node
CREATE (s:{prefix}Symbol {
  id: UUID,
  name: STRING,
  type: STRING,
  file_id: UUID,
  line: INTEGER,
  column: INTEGER
})

// File node
CREATE (f:{prefix}File {
  id: UUID,
  path: STRING,
  language: STRING,
  hash: STRING
})

// Cluster node
CREATE (c:{prefix}Cluster {
  id: UUID,
  name: STRING,
  size: INTEGER,
  modularity: FLOAT
})

// Process node
CREATE (p:{prefix}Process {
  id: UUID,
  name: STRING,
  entry_point: STRING,
  depth: INTEGER
})

// Metadata node
CREATE (m:{prefix}Metadata {
  id: UUID,
  key: STRING,
  value: STRING
})
```

## Neo4j Relationship Types

**Base Types and Prefixing:**
```
CALLS       → {prefix}CALLS
IMPORTS     → {prefix}IMPORTS
INHERITS    → {prefix}INHERITS
IMPLEMENTS  → {prefix}IMPLEMENTS
CONTAINS    → {prefix}CONTAINS
REFERENCES  → {prefix}REFERENCES
DEFINES     → {prefix}DEFINES
```

**Relationship Properties (unchanged by prefixing):**
```cypher
// CALLS relationship
(s1:{prefix}Symbol)-[:{prefix}CALLS {
  count: INTEGER,
  line: INTEGER
}]->(s2:{prefix}Symbol)

// IMPORTS relationship
(f1:{prefix}File)-[:{prefix}IMPORTS {
  module: STRING,
  line: INTEGER
}]->(f2:{prefix}File)

// INHERITS relationship
(s1:{prefix}Symbol)-[:{prefix}INHERITS {
  line: INTEGER
}]->(s2:{prefix}Symbol)

// IMPLEMENTS relationship
(s1:{prefix}Symbol)-[:{prefix}IMPLEMENTS {
  line: INTEGER
}]->(s2:{prefix}Symbol)

// CONTAINS relationship
(f:{prefix}File)-[:{prefix}CONTAINS {
  order: INTEGER
}]->(s:{prefix}Symbol)

// REFERENCES relationship
(s1:{prefix}Symbol)-[:{prefix}REFERENCES {
  line: INTEGER
}]->(s2:{prefix}Symbol)

// DEFINES relationship
(s1:{prefix}Symbol)-[:{prefix}DEFINES {
  line: INTEGER
}]->(s2:{prefix}Symbol)
```

## Prefix Normalization Algorithm

**Unified Prefix Normalization (applies to both PostgreSQL and Neo4j):**
```
Input: prefix (string)
Output: normalized_prefix (string) or error

1. If prefix does not start with [a-z]:
   return error "Prefix must start with a lowercase letter"
2. If prefix contains uppercase letters:
   return error "Prefix must be lowercase only"
3. If prefix contains non-alphanumeric/underscore:
   return error "Prefix must contain only [a-z0-9_]"
4. If length > 32:
   return error "Prefix must be ≤ 32 characters"
5. If prefix does not end with "_":
   return prefix + "_"
6. Return prefix
```

**Default Prefix Resolution:**
```
Input: env_value (string | undefined)
Output: effective_prefix (string)

1. If env_value is undefined (not set):
   return "tpc_"  (default)
2. Else:
   return normalize(env_value)
```

## Query Construction Algorithm

**Cypher Query with Prefixed Labels:**
```
Input: prefix (string), base_label (string), query_template (string)
Output: prefixed_query (string)

1. prefixed_label = prefix + base_label
2. Replace all occurrences of base_label with prefixed_label in query_template
3. Return prefixed_query

Example:
  prefix = "typocop_"
  base_label = "Symbol"
  template = "MATCH (s:Symbol) RETURN s"
  output = "MATCH (s:typocop_Symbol) RETURN s"
```

**SQL Query with Prefixed Tables:**
```
Input: prefix (string), base_table (string), query_template (string)
Output: prefixed_query (string)

1. prefixed_table = prefix + base_table
2. Replace all occurrences of base_table with prefixed_table in query_template
3. Return prefixed_query

Example:
  prefix = "typocop_"
  base_table = "embeddings"
  template = "SELECT * FROM embeddings WHERE id = $1"
  output = "SELECT * FROM typocop_embeddings WHERE id = $1"
```

## Configuration Propagation Algorithm

**Initialization Flow:**
```
1. Application starts
2. Configuration_Manager.initialize():
   a. Read TYPOCOP_PREFIX from environment
   b. Resolve effective prefix (default "tpc_" if unset)
   c. Validate prefix using normalize()
   d. If validation fails, throw ConfigurationError
   e. Store normalized prefix
   f. Log effective prefix at startup
3. Vector_Store initialized with prefix
4. Graph_Store initialized with same prefix
5. Query builders receive prefix from their respective stores
6. All subsequent queries use prefixed names
```

## Response Stripping Algorithm

**Strip Prefixes from Query Results:**
```
Input: result (object), prefix (string)
Output: stripped_result (object)

For each node in result:
  1. If node.label starts with prefix:
     node.label = node.label.substring(prefix.length)
  2. For each relationship in node:
     If relationship.type starts with prefix:
       relationship.type = relationship.type.substring(prefix.length)

Return stripped_result

Example:
  Input: {label: "typocop_Symbol", type: "typocop_CALLS"}
  Prefix: "typocop_"
  Output: {label: "Symbol", type: "CALLS"}
```

## Error Handling Flow

**Configuration Error Handling:**
```
1. Prefix validation fails
2. Throw ConfigurationError with:
   - message: descriptive error
   - prefix: the invalid prefix
   - reason: why it's invalid
   - suggestion: corrected prefix if possible
3. CLI catches error and displays user-friendly message
4. Application exits with code 1
5. No database operations attempted
```

**Runtime Error Handling:**
```
1. Query execution fails due to prefix issue
2. Catch database error
3. Log error with prefix information
4. Throw DatabaseError with context
5. Caller handles error appropriately
```
