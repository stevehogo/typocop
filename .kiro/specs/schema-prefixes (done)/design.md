# Design Document: Schema Prefixes for PostgreSQL and Neo4j

**Related documents:**
- [Components & Interfaces](./design-components.md)
- [Data Models & Algorithms](./design-data-models.md)
- [Correctness Properties](./design-correctness.md)

## Overview

This design enables configurable schema prefixes for PostgreSQL tables and Neo4j node labels/relationship types, allowing multiple Typocop instances to coexist in the same database infrastructure without data conflicts.

**Key Design Principles:**
- Configuration-driven: single prefix loaded from environment variable at startup
- Validation-first: invalid prefixes rejected before any database operations
- Transparent propagation: both database modules receive the same prefix automatically
- Default prefix: `tpc_` applied when `TYPOCOP_PREFIX` is not set

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Startup                       │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────┐
        │  Configuration Manager         │
        │  - Read env vars               │
        │  - Validate prefixes           │
        │  - Propagate to modules        │
        └────────┬───────────────────────┘
                 │
        ┌────────┴──────────────┐
        │                       │
        ▼                       ▼
   ┌─────────────┐      ┌──────────────┐
   │ Vector Store│      │ Graph Store  │
   │ (PostgreSQL)│      │ (Neo4j)      │
   └─────────────┘      └──────────────┘
        │                       │
        ▼                       ▼
   ┌─────────────┐      ┌──────────────┐
   │ Prefixed    │      │ Prefixed     │
   │ Tables      │      │ Labels/Types │
   └─────────────┘      └──────────────┘
```

## Configuration Management

**Configuration Manager Responsibilities:**
1. Read `TYPOCOP_PREFIX` from environment (default: `tpc_`)
2. Validate prefix against unified naming rules (compatible with both PostgreSQL and Neo4j)
3. Normalize prefix (append underscore if missing)
4. Propagate single prefix to both Vector_Store and Graph_Store at initialization
5. Provide getter method for debugging

**Validation Rules:**
- Pattern: `^[a-z][a-z0-9_]*$` (lowercase letter start, lowercase alphanumeric + underscores)
- Max 32 characters
- Auto-append `_` if missing
- Reject if invalid, throw Configuration_Error with descriptive message

**Error Handling:**
- Invalid prefix → Configuration_Error with naming rules and suggestion
- Validation at startup → fail fast before database operations

## PostgreSQL Implementation

**Table Prefixing Strategy:**
- Base tables: `embeddings`, `metadata`
- Prefixed names: `{prefix}embeddings`, `{prefix}metadata` (e.g., `tpc_embeddings`)

**Integration Points:**
- Vector_Store constructor: receive prefix, store as instance property
- Query methods: concatenate prefix + table name in all SQL statements
- Index creation: use prefixed table names in CREATE INDEX statements
- Schema initialization: create prefixed tables on first run

## Neo4j Implementation

**Node Label Prefixing Strategy:**
- Base labels: `Symbol`, `File`, `Cluster`, `Process`, `Metadata`
- Prefixed names: `{prefix}Symbol`, `{prefix}File`, etc. (e.g., `tpc_Symbol`)

**Relationship Type Prefixing Strategy:**
- Base types: `CALLS`, `IMPORTS`, `INHERITS`, `IMPLEMENTS`, `CONTAINS`, `REFERENCES`, `DEFINES`
- Prefixed names: `{prefix}CALLS`, `{prefix}IMPORTS`, etc. (e.g., `tpc_CALLS`)

**Integration Points:**
- Graph_Store constructor: receive prefix, store as instance property
- MATCH queries: use prefixed labels and types
- MERGE/CREATE statements: use prefixed labels and types
- DELETE operations: use prefixed labels and types

## Query Builder Modifications

**Cypher Query Builder:**
- Accept prefix in constructor or via setter
- Automatically prepend prefix to all node labels in MATCH/MERGE/CREATE
- Automatically prepend prefix to all relationship types
- Provide method to retrieve current prefix for debugging

**SQL Query Builder:**
- Accept prefix in constructor or via setter
- Automatically prepend prefix to all table names in SELECT/INSERT/UPDATE/DELETE
- Automatically prepend prefix to all table names in CREATE INDEX
- Provide method to retrieve current prefix for debugging

## Integration Points

**CLI:**
- Read prefix configuration from environment at startup
- Pass prefixes to indexing pipeline (parse, reindex commands)
- Use prefixes for status queries

**Query Server:**
- Read prefix configuration from environment at startup
- Use prefixes for all graph and vector queries
- Strip prefixes from response labels/types (clients see clean names)

**MCP Server:**
- Inherit prefix configuration from Query Server
- Use prefixes for all database operations
- Strip prefixes from tool response labels/types


