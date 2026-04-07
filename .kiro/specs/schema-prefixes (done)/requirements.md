# Requirements Document: Schema Prefixes for PostgreSQL and Neo4j

**Related documents:**
- [Operations, Testing & Documentation Requirements](./requirements-operations.md)

## Introduction

The Typocop code graph analyzer currently uses hardcoded database identifiers for PostgreSQL tables and Neo4j node labels/relationship types. This feature adds a single configurable schema prefix via the `TYPOCOP_PREFIX` environment variable. The prefix applies to both PostgreSQL tables and Neo4j node labels/relationship types, enabling namespace isolation without requiring separate database instances. When not set, the default prefix is `tpc_`.

## Glossary

- **Schema Prefix**: A string prepended to database identifiers (table names, node labels, relationship types) to namespace data. Example: `tpc_` creates tables like `tpc_embeddings` and labels like `tpc_Symbol`.
- **TYPOCOP_PREFIX**: The single environment variable controlling the prefix for all database identifiers in both PostgreSQL and Neo4j.
- **PostgreSQL Table**: A relational table in PostgreSQL storing embeddings and metadata. Currently: `embeddings`, `metadata`.
- **Neo4j Node Label**: A classification label on Neo4j nodes. Currently: `Symbol`, `File`, `Cluster`, `Process`, `Metadata`.
- **Neo4j Relationship Type**: A classification for relationships between nodes. Currently: `CALLS`, `IMPORTS`, `INHERITS`, `IMPLEMENTS`, `CONTAINS`, `REFERENCES`, `DEFINES`.
- **Environment Configuration**: Settings loaded from environment variables (`.env` files or system environment).
- **Prefix Validation**: Ensuring the prefix conforms to naming rules valid for both PostgreSQL and Neo4j.

## Requirements

### Requirement 1: Environment Configuration for Schema Prefix

**User Story:** As a DevOps engineer, I want to configure a schema prefix via a single environment variable, so that I can deploy multiple Typocop instances to the same database infrastructure without data conflicts.

#### Acceptance Criteria

1. WHEN the application starts, THE Configuration_Manager SHALL read `TYPOCOP_PREFIX` from environment variables.
2. WHERE `TYPOCOP_PREFIX` is not set, THE Configuration_Manager SHALL default to `tpc_`.
3. WHEN a prefix is provided, THE Configuration_Manager SHALL validate it against naming rules before accepting it.
4. IF a prefix is invalid, THEN THE Configuration_Manager SHALL throw a Configuration_Error with a descriptive message.
5. THE Configuration_Manager SHALL expose the validated prefix via a public API for use by all database modules.

### Requirement 2: Prefix Validation

**User Story:** As a system administrator, I want the prefix to be validated against rules compatible with both PostgreSQL and Neo4j, so that invalid prefixes don't corrupt identifiers or cause database errors.

#### Acceptance Criteria

1. WHEN a prefix is provided, THE Prefix_Validator SHALL verify it matches the pattern `^[a-z][a-z0-9_]*$` (lowercase letter start, followed by lowercase alphanumeric and underscores only).
2. IF a prefix contains uppercase letters, THEN THE Prefix_Validator SHALL reject it and suggest converting to lowercase.
3. IF a prefix contains special characters (hyphens, dots, spaces), THEN THE Prefix_Validator SHALL reject it.
4. IF a prefix is longer than 32 characters, THEN THE Prefix_Validator SHALL reject it.
5. WHERE a prefix ends with an underscore, THE Prefix_Validator SHALL accept it (e.g., `tpc_` is valid).
6. WHERE a prefix does not end with an underscore, THE Prefix_Validator SHALL append one automatically (e.g., `tpc` becomes `tpc_`).

### Requirement 3: PostgreSQL Table Prefix Implementation

**User Story:** As a developer, I want PostgreSQL table names to be dynamically prefixed, so that multiple Typocop instances can share the same database.

#### Acceptance Criteria

1. WHEN the Vector_Store initializes, THE Vector_Store SHALL construct table names by concatenating the prefix with the base table name.
2. THE Vector_Store SHALL prefix the following tables: `embeddings`, `metadata`.
3. WHEN prefix is `tpc_`, THE Vector_Store SHALL use prefixed names (e.g., `tpc_embeddings`, `tpc_metadata`).
4. WHEN creating tables, THE Vector_Store SHALL use the prefixed table names in all CREATE TABLE statements.
5. WHEN querying tables, THE Vector_Store SHALL use the prefixed table names in all SELECT, INSERT, UPDATE, DELETE statements.
6. WHEN creating indexes, THE Vector_Store SHALL use the prefixed table names in all CREATE INDEX statements.

### Requirement 4: Neo4j Node Label Prefix Implementation

**User Story:** As a developer, I want Neo4j node labels to be dynamically prefixed, so that multiple Typocop instances can share the same Neo4j database.

#### Acceptance Criteria

1. WHEN the Graph_Store initializes, THE Graph_Store SHALL construct node labels by concatenating the prefix with the base label name.
2. THE Graph_Store SHALL prefix the following node labels: `Symbol`, `File`, `Cluster`, `Process`, `Metadata`.
3. WHEN prefix is `tpc_`, THE Graph_Store SHALL use prefixed names (e.g., `tpc_Symbol`, `tpc_File`).
4. WHEN creating nodes, THE Graph_Store SHALL use the prefixed labels in all MERGE and CREATE statements.
5. WHEN querying nodes, THE Graph_Store SHALL use the prefixed labels in all MATCH statements.
6. WHEN deleting nodes, THE Graph_Store SHALL use the prefixed labels in all DELETE statements.

### Requirement 5: Neo4j Relationship Type Prefix Implementation

**User Story:** As a developer, I want Neo4j relationship types to be dynamically prefixed, so that multiple Typocop instances can share the same Neo4j database.

#### Acceptance Criteria

1. WHEN the Graph_Store initializes, THE Graph_Store SHALL construct relationship types by concatenating the prefix with the base relationship type name.
2. THE Graph_Store SHALL prefix the following relationship types: `CALLS`, `IMPORTS`, `INHERITS`, `IMPLEMENTS`, `CONTAINS`, `REFERENCES`, `DEFINES`.
3. WHEN prefix is `tpc_`, THE Graph_Store SHALL use prefixed names (e.g., `tpc_CALLS`, `tpc_IMPORTS`).
4. WHEN creating relationships, THE Graph_Store SHALL use the prefixed types in all MERGE and CREATE statements.
5. WHEN querying relationships, THE Graph_Store SHALL use the prefixed types in all MATCH statements.
6. WHEN deleting relationships, THE Graph_Store SHALL use the prefixed types in all DELETE statements.

### Requirement 6: Configuration Propagation to Database Modules

**User Story:** As a developer, I want database modules to automatically receive prefix configuration, so that I don't have to manually pass prefixes to every function.

#### Acceptance Criteria

1. WHEN the application initializes, THE Configuration_Manager SHALL pass the validated prefix to the Vector_Store and Graph_Store.
2. THE Vector_Store SHALL store the prefix as an instance property.
3. THE Graph_Store SHALL store the prefix as an instance property.
4. WHEN a database module needs to construct a table name or label, THE module SHALL use its stored prefix.
5. THE Configuration_Manager SHALL provide a method to retrieve the current prefix for debugging.

### Requirement 7: CLI Support for Prefix Configuration

**User Story:** As a DevOps engineer, I want to configure the prefix via environment variables, so that I can easily deploy Typocop with different prefix settings.

#### Acceptance Criteria

1. WHEN the CLI starts, THE CLI_Parser SHALL read `TYPOCOP_PREFIX` from environment variables.
2. WHEN the `parse` command is executed, THE CLI SHALL pass the configured prefix to the indexing pipeline.
3. WHEN the `status` command is executed, THE CLI SHALL use the configured prefix to query the database.
4. WHEN the `reindex` command is executed, THE CLI SHALL use the configured prefix for all database operations.

### Requirement 9: Query Server Support for Prefix Configuration

**User Story:** As a developer, I want the query server to support prefix configuration, so that MCP tools can query prefixed databases.

#### Acceptance Criteria

1. WHEN the Query_Server initializes, THE Query_Server SHALL read `TYPOCOP_PREFIX` from environment variables.
2. WHEN executing a query, THE Query_Server SHALL use the configured prefix to construct graph and vector queries.
3. WHEN returning results, THE Query_Server SHALL strip the prefix from node labels and relationship types in the response.
4. WHEN executing MCP tool calls, THE MCP_Server SHALL use the configured prefix for all database operations.
