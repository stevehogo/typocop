# Design Document: Obsidian Export

**Related documents:**
- [Components & Interfaces](./design-components.md)
- [Data Models & Output Formats](./design-data-models.md)
- [Algorithms](./design-algorithms.md)
- [Correctness & Testing](./design-correctness.md)

## Overview

The `obsidian-export` feature adds a new CLI command (`typocop obsidian`) that reads the precomputed code graph from Neo4j and generates an Obsidian-compatible markdown vault. The vault mirrors the source directory structure — each source file becomes a markdown file containing all symbols from that file, with YAML frontmatter metadata, Obsidian wikilinks for cross-referencing, and Mermaid diagrams for data flow visualization.

The command is read-only against the graph database — it does not re-parse or re-scan source files. It exports everything: all symbols, clusters, processes, and relationships. The output is a self-contained Obsidian vault with index files for navigation.

This feature enables developers to browse their codebase's precomputed intelligence using Obsidian's graph view, backlinks, and search capabilities — providing an offline, visual exploration experience of the code graph.

## Architecture

```mermaid
graph TD
    CLI[CLI: typocop obsidian] --> CMD[ObsidianCommand]
    CMD --> READER[GraphReader]
    READER --> NEO4J[(Neo4j Database)]
    CMD --> RENDERER[MarkdownRenderer]
    RENDERER --> SYMBOL_R[SymbolFileRenderer]
    RENDERER --> INDEX_R[IndexRenderer]
    RENDERER --> PROCESS_R[ProcessRenderer]
    CMD --> WRITER[VaultWriter]
    WRITER --> FS[File System: .typocop-obsidian/]
```

## Sequence Diagrams

### Main Export Flow

```mermaid
sequenceDiagram
    participant User
    participant CLI as CLI Parser
    participant Exec as Executor
    participant GR as GraphReader
    participant Neo as Neo4j
    participant MR as MarkdownRenderer
    participant VW as VaultWriter
    participant FS as File System

    User->>CLI: typocop obsidian [--out path]
    CLI->>Exec: CLICommand { type: "obsidian" }
    Exec->>GR: fetchAllGraphData(session, prefix)
    GR->>Neo: MATCH symbols, clusters, processes, relationships
    Neo-->>GR: Raw graph data
    GR-->>Exec: GraphData { symbols, clusters, processes, relationships }
    Exec->>MR: renderVault(graphData)
    MR->>MR: groupSymbolsByFile(symbols)
    MR->>MR: renderSymbolFiles(grouped)
    MR->>MR: renderClusterIndexes(clusters)
    MR->>MR: renderProcessFiles(processes)
    MR->>MR: renderNavigationIndex()
    MR-->>Exec: VaultContent { files: Map<path, content> }
    Exec->>VW: writeVault(outputPath, vaultContent)
    VW->>FS: mkdir + writeFile for each entry
    VW-->>Exec: WriteResult { filesWritten, totalBytes }
    Exec-->>User: "Exported N files to .typocop-obsidian/"
```

### Graph Data Fetching

```mermaid
sequenceDiagram
    participant GR as GraphReader
    participant Neo as Neo4j Session

    GR->>Neo: MATCH (s:prefix_Symbol) RETURN s
    Neo-->>GR: Symbol nodes
    GR->>Neo: MATCH (c:prefix_Cluster) RETURN c
    Neo-->>GR: Cluster nodes
    GR->>Neo: MATCH (p:prefix_Process) RETURN p
    Neo-->>GR: Process nodes
    GR->>Neo: MATCH ()-[r]->() WHERE type(r) STARTS WITH prefix RETURN r
    Neo-->>GR: All relationships
    GR->>Neo: MATCH (c:prefix_Cluster)-[:prefix_CONTAINS]->(s) RETURN c.id, s.id
    Neo-->>GR: Cluster memberships
    GR->>Neo: MATCH (p:prefix_Process)-[:prefix_HAS_STEP]->(s) RETURN p.id, s.id, r.order
    Neo-->>GR: Process steps
```

## Vault Directory Structure

```
.typocop-obsidian/
├── _index.md                    # Top-level navigation
├── _clusters/
│   ├── _index.md               # Cluster listing
│   ├── authentication.md       # One file per cluster
│   └── ...
├── _processes/
│   ├── _index.md               # Process listing
│   ├── user-login-flow.md      # One file per process (with Mermaid)
│   └── ...
└── src/                         # Mirrors source directory
    ├── cli/
    │   ├── parser.md           # All symbols from src/cli/parser.ts
    │   └── executor.md
    ├── graph/
    │   ├── graph-store.md
    │   └── connection.md
    └── ...
```

## Dependencies

- `neo4j-driver` — existing dependency for graph queries
- `node:fs/promises` — file system operations (mkdir, writeFile, rm)
- `node:path` — path manipulation (join, dirname, resolve)
- No new external dependencies required
