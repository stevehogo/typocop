# Multi-Tenancy Prefix Support Bugfix

## Introduction

Typocop has a `GraphStore` class with prefix support, but neither the Neo4j indexing pipeline nor the PostgreSQL vector store actually use it. The indexer writes to Neo4j with hardcoded unprefixed labels (`Symbol`, `Cluster`, `Process`) and relationship types (`CALLS`, `CONTAINS`, `HAS_STEP`). PostgreSQL stores embeddings in a hardcoded unprefixed `embeddings` table. Both databases are shared across all Typocop instances, causing data collisions when multiple instances with different prefixes coexist.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the indexer pipeline stores nodes in Neo4j THEN it uses hardcoded unprefixed labels (`Symbol`, `Cluster`, `Process`, `File`) shared across all instances

1.2 WHEN the indexer pipeline stores relationships in Neo4j THEN it uses hardcoded unprefixed types (`CALLS`, `CONTAINS`, `HAS_STEP`) shared across all instances

1.3 WHEN a second Typocop instance with a different prefix indexes into the same Neo4j database THEN its nodes and relationships collide with the first instance's data

1.4 WHEN `semanticSearch` queries embeddings in PostgreSQL THEN it queries the hardcoded unprefixed `embeddings` table, retrieving embeddings from all instances

1.5 WHEN `indexSymbol` stores an embedding in PostgreSQL THEN it inserts into the hardcoded unprefixed `embeddings` table without isolation

1.6 WHEN `initVectorStore` initializes PostgreSQL THEN it creates unprefixed table and index names shared across all instances

### Expected Behavior (Correct)

2.1 WHEN the indexer pipeline stores nodes in Neo4j THEN it uses prefixed labels (e.g., `tpc_Symbol`, `tpc_Cluster`) unique to the instance

2.2 WHEN the indexer pipeline stores relationships in Neo4j THEN it uses prefixed types (e.g., `tpc_CALLS`, `tpc_CONTAINS`) unique to the instance

2.3 WHEN a second Typocop instance with prefix `myapp_` indexes into the same Neo4j database THEN its data is fully isolated under `myapp_Symbol`, `myapp_CALLS`, etc.

2.4 WHEN `semanticSearch` queries embeddings THEN it queries the prefixed table (e.g., `tpc_embeddings`) for the current instance only

2.5 WHEN `indexSymbol` stores an embedding THEN it inserts into the prefixed table (e.g., `tpc_embeddings`) for the current instance only

2.6 WHEN `initVectorStore` initializes PostgreSQL THEN it creates prefixed table and index names (e.g., `tpc_embeddings`, `tpc_embeddings_hnsw_idx`)

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a single Typocop instance with default prefix `tpc_` indexes and queries Neo4j THEN results are identical to before the fix

3.2 WHEN a single Typocop instance with default prefix `tpc_` performs semantic search THEN results are identical to before the fix

3.3 WHEN the Neo4j query layer reads nodes by `id` or `name` THEN it continues to work correctly (queries match on properties, not labels)

3.4 WHEN the PostgreSQL connection pool is created THEN connection and retry logic remain unchanged

3.5 WHEN the HNSW index is used for approximate nearest neighbor search THEN index performance and accuracy remain unchanged

3.6 WHEN the metadata JSONB column stores symbol metadata THEN storage and retrieval logic remain unchanged
