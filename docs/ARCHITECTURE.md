# Architecture Overview

This document provides a high-level overview of the Code Graph Analyzer (Typocop) architecture and how components interact.

## System Components

```
┌─────────────┐
│  CLI Tool   │ ← User entry point
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│              Indexing Pipeline                          │
│  (src/indexer/pipeline.ts)                             │
│                                                         │
│  Phase 1: Structure  → Walk file tree                  │
│  Phase 2: Parsing    → Extract symbols (tree-sitter)   │
│  Phase 3: Resolution → Resolve references              │
│  Phase 4: Clustering → Group symbols (Louvain)         │
│  Phase 5: Processes  → Trace execution flows           │
│  Phase 6: Search     → Build hybrid indexes            │
└────────┬────────────────────────────────┬──────────────┘
         │                                │
         ▼                                ▼
    ┌─────────┐                    ┌──────────────┐
    │  Neo4j  │                    │ PostgreSQL + │
    │  Graph  │                    │   pgvector   │
    │   DB    │                    │              │
    └────┬────┘                    └──────┬───────┘
         │                                │
         └────────────┬───────────────────┘
                      │
                      ▼
              ┌───────────────┐
              │ Query Server  │ ← HTTP API
              │  (Fastify)    │
              └───────┬───────┘
                      │
                      ▼
              ┌───────────────┐
              │  MCP Server   │ ← Model Context Protocol
              └───────┬───────┘
                      │
                      ▼
         ┌────────────────────────────┐
         │  AI Editors (Kiro, Claude, │
         │  Cursor, Windsurf)         │
         └────────────────────────────┘
```

## Pipeline Orchestration

The `runIndexingPipeline` function in `src/indexer/pipeline.ts` is the main orchestrator that:

1. **Accepts configuration** including source path, language, and database connections
2. **Executes phases sequentially** with early exit on empty results
3. **Logs progress** when verbose mode is enabled
4. **Stores results** in both Neo4j (graph structure) and pgvector (semantic search)
5. **Returns statistics** including symbol count, relationship count, and skipped files

### Phase Dependencies

Each phase depends on the output of previous phases:

```
Phase 1 (Structure)
  └─> FileNode[] 
      └─> Phase 2 (Parsing)
          └─> Symbol[]
              └─> Phase 3 (Resolution)
                  └─> Relationship[]
                      ├─> Phase 4 (Clustering)
                      │   └─> Cluster[]
                      │       └─> Phase 6 (Search)
                      └─> Phase 5 (Processes)
                          └─> Process[]
                              └─> Phase 6 (Search)
```

### Database Storage

After all phases complete, results are stored in two databases:

**Neo4j Graph Database:**
- Symbol nodes (labeled by kind: function, class, method, etc.)
- Cluster nodes (functional communities)
- Process nodes (execution flows)
- Relationships: CALLS, IMPORTS, INHERITS, IMPLEMENTS, BELONGS_TO, PART_OF

**PostgreSQL with pgvector:**
- Symbol embeddings (1536 dimensions via OpenAI text-embedding-3-large with dimension reduction)
- Cluster embeddings for semantic search
- HNSW index for fast similarity search (<100ms target)

## Key Design Decisions

### Sequential Execution

The pipeline executes phases sequentially rather than in parallel because:
- Each phase depends on complete results from previous phases
- Memory efficiency: process and release data phase by phase
- Simpler error handling and progress tracking
- Easier to debug and test individual phases

### Early Exit on Empty Results

If any phase produces zero results, the pipeline returns early with empty collections. This prevents:
- Unnecessary computation in downstream phases
- Database operations on empty datasets
- Confusing error messages from phases expecting input

### Verbose Logging

When `verbose: true`, the pipeline logs:
- Phase start/completion messages
- Result counts (files found, symbols extracted, relationships resolved, etc.)
- Storage operations

This provides visibility into long-running indexing operations without overwhelming the console.

### Database Connection Management

The pipeline accepts active database connections (Neo4j session, PostgreSQL pool) rather than creating them internally. This allows:
- Connection reuse across multiple pipeline runs
- Proper connection lifecycle management by the caller
- Transaction control at the CLI level
- Easier testing with mock connections

## Error Handling

The pipeline follows these error handling principles:

1. **Phase failures halt the pipeline** - If a phase throws an error, the pipeline stops immediately
2. **Empty results are valid** - Zero symbols or relationships is not an error
3. **Database errors propagate** - Connection or query failures throw to the caller
4. **Parsing errors are logged** - Individual file parsing failures are tracked in `skippedFiles`

## Performance Characteristics

Target performance metrics:

- **Indexing throughput**: ≥10,000 LOC/s
- **Phase 1 (Structure)**: O(n) where n = file count
- **Phase 2 (Parsing)**: O(n × m) where m = average file size
- **Phase 3 (Resolution)**: O(s²) where s = symbol count (optimized with symbol table)
- **Phase 4 (Clustering)**: O(s + r) where r = relationship count (Louvain algorithm)
- **Phase 5 (Processes)**: O(s × d) where d = average call depth
- **Phase 6 (Search)**: O(s) for embedding generation, O(log s) for HNSW indexing

## Testing Strategy

The pipeline is tested at multiple levels:

1. **Unit tests**: Each phase function tested independently with mock data
2. **Integration tests**: Full pipeline execution on sample codebases
3. **Property tests**: Correctness properties validated with fast-check
4. **Performance tests**: Throughput and latency benchmarks

See `src/indexer/pipeline.test.ts` for test implementation.

## Related Documentation

- [Design Document](.kiro/specs/code-graph-analyzer/design.md) - System architecture and diagrams
- [Components & Interfaces](.kiro/specs/code-graph-analyzer/design-components.md) - Detailed component specifications
- [Data Models](.kiro/specs/code-graph-analyzer/design-data-models.md) - Type definitions and algorithms
- [Implementation Tasks](.kiro/specs/code-graph-analyzer/tasks.md) - Task breakdown and progress
