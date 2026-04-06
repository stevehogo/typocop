# Bugfix Requirements Document

## Introduction

The indexer pipeline in `src/indexer/pipeline.ts` stores cluster and process relationship edges with incorrect relationship types and reversed directions. As a result, the graph queries `findClustersBySymbol` and `findProcessesBySymbol` always return empty results, causing MCP tool responses to never include cluster or process context for any symbol.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN cluster membership edges are written to the graph THEN the system stores them as `(symbol)-[:BELONGS_TO]->(cluster)` (symbol → cluster direction, wrong type)

1.2 WHEN process step edges are written to the graph THEN the system stores them as `(symbol)-[:PART_OF]->(process)` (symbol → process direction, wrong type)

1.3 WHEN `findClustersBySymbol` is called with any symbol ID THEN the system returns an empty array because no `(Cluster)-[:CONTAINS]->(symbol)` edges exist

1.4 WHEN `findProcessesBySymbol` is called with any symbol ID THEN the system returns an empty array because no `(Process)-[:HAS_STEP]->(symbol)` edges exist

1.5 WHEN an MCP tool such as `get_symbol_context` is invoked THEN the system returns empty `clusters` and `processes` arrays in the response

### Expected Behavior (Correct)

2.1 WHEN cluster membership edges are written to the graph THEN the system SHALL store them as `(cluster)-[:CONTAINS]->(symbol)` (cluster → symbol direction, correct type)

2.2 WHEN process step edges are written to the graph THEN the system SHALL store them as `(process)-[:HAS_STEP]->(symbol)` (process → symbol direction, correct type)

2.3 WHEN `findClustersBySymbol` is called with a symbol ID that belongs to one or more clusters THEN the system SHALL return those Cluster nodes

2.4 WHEN `findProcessesBySymbol` is called with a symbol ID that is a step in one or more processes THEN the system SHALL return those Process nodes

2.5 WHEN an MCP tool such as `get_symbol_context` is invoked for a symbol that belongs to clusters and processes THEN the system SHALL return non-empty `clusters` and `processes` arrays in the response

### Unchanged Behavior (Regression Prevention)

3.1 WHEN symbol-to-symbol relationship edges (CALLS, IMPORTS, INHERITS, etc.) are written to the graph THEN the system SHALL CONTINUE TO store them with their original source, target, and relType unchanged

3.2 WHEN `findNode` is called with a symbol ID or name THEN the system SHALL CONTINUE TO return the correct node

3.3 WHEN `findDependents` is called for a symbol THEN the system SHALL CONTINUE TO return all symbols that depend on it

3.4 WHEN `findDependencies` is called for a symbol THEN the system SHALL CONTINUE TO return all symbols it depends on

3.5 WHEN cluster and process nodes are written to the graph THEN the system SHALL CONTINUE TO store their node properties (name, category, confidence, stepCount, etc.) correctly

3.6 WHEN `traversePath` is called between two symbols THEN the system SHALL CONTINUE TO return the correct relationship paths
