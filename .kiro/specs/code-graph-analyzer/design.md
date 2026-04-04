# Design Document: Code Graph Analyzer

## Overview

The Code Graph Analyzer is a precomputed relational intelligence system that transforms source code into a queryable knowledge graph. Unlike traditional AI agents that rely on iterative text searches (grep/find) and multiple slow query chains, this system precomputes the entire code structure—clustering, tracing, and scoring—delivering complete and precise context in a single call with 90%+ confidence.

Traditional agents waste tokens on 10-query chains to understand one function, often missing context and hitting token limits. Typocop's approach provides:
- **Reliability**: LLM can't miss context, it's already in the tool response
- **Token Efficiency**: No iterative searches, complete answers in one query
- **Model Democratization**: Smaller LLMs work because tools do the heavy lifting

The architecture follows a pipeline design: CLI tool for code ingestion → Multi-phase indexer (6 phases) → Graph database storage → Query server with semantic search → MCP server for editor integration. This enables use cases like impact analysis, smart search, 360° context, pre-commit checks, and data flow tracing across frameworks like Magento 2, NestJS, Laravel, Express, and Fastify.

**Related design documents:**
- [Components & Interfaces](./design-components.md)
- [Data Models & Algorithms](./design-data-models.md)
- [Use Cases & Correctness Properties](./design-correctness.md)

## System Context Diagram

```mermaid
C4Context
    title System Context: Code Graph Analyzer (Typocop)

    Person(developer, "Developer", "Indexes codebases, runs queries, performs impact analysis and data flow tracing")
    Person(aiEditor, "AI Editor User", "Uses Claude, Cursor, Windsurf, or Antigravity with MCP integration")

    System_Boundary(Typocop, "Typocop - Code Graph Analyzer") {
        System(cli, "CLI Tool", "Parses source code and triggers the 6-phase indexing pipeline")
        System(indexer, "Multi-Phase Indexer", "Transforms ASTs into a knowledge graph (6 phases)")
        System(queryServer, "Query Server", "Processes natural language queries via HTTP API")
        System(mcpServer, "MCP Server", "Exposes tools to AI editors via Model Context Protocol")
    }

    System_Ext(embeddingApi, "OpenAI Embeddings API", "text-embedding-3-large, 3072 dimensions — used for semantic indexing of symbols and clusters")
    System_Ext(neo4j, "Neo4j Graph Database", "Stores symbols, relationships, clusters, and processes as a traversable graph")
    System_Ext(pgvector, "PostgreSQL + pgvector", "Stores and queries 3072-dimensional embeddings for semantic search")
    System_Ext(treeSitter, "tree-sitter (npm)", "AST parsing for 12 languages: TS, JS, Python, Java, Go, Rust, C, C++, C#, PHP, Ruby, Swift")

    Rel(developer, cli, "Runs parse/reindex commands")
    Rel(developer, queryServer, "Sends HTTP queries")
    Rel(aiEditor, mcpServer, "Sends MCP tool calls")

    Rel(cli, indexer, "Triggers pipeline")
    Rel(indexer, treeSitter, "Parses source files into ASTs")
    Rel(indexer, embeddingApi, "Sends symbol signatures for embedding")
    Rel(indexer, neo4j, "Stores graph nodes and edges")
    Rel(indexer, pgvector, "Stores embeddings")

    Rel(queryServer, neo4j, "Graph traversal queries")
    Rel(queryServer, pgvector, "Semantic similarity search")
    Rel(mcpServer, queryServer, "Forwards MCP requests as HTTP queries")
```

## Architecture

```mermaid
graph TD
    CLI[CLI Tool] --> Parser[AST Parser - tree-sitter]
    Parser --> Phase1[Phase 1: Structure]
    Phase1 --> Phase2[Phase 2: Parsing]
    Phase2 --> Phase3[Phase 3: Resolution]
    Phase3 --> Phase4[Phase 4: Clustering]
    Phase4 --> Phase5[Phase 5: Processes]
    Phase5 --> Phase6[Phase 6: Search Index]

    Phase6 --> GraphDB[(Neo4j Graph DB)]
    Phase6 --> VectorDB[(PostgreSQL + pgvector)]

    GraphDB --> QueryServer[Query Server - Fastify]
    VectorDB --> QueryServer

    QueryServer --> NLProcessor[NL Query Processor]
    QueryServer --> GraphQuery[Graph Query Engine]

    NLProcessor --> MCPServer[MCP Server - @modelcontextprotocol/sdk]
    GraphQuery --> MCPServer

    MCPServer --> Kiro[Kiro Editor]
    MCPServer --> Antigravity[Google Antigravity]
    MCPServer --> Claude[Claude]
```

## Core Innovation: Precomputed Relational Intelligence

### Traditional AI Agents vs Typocop

**Traditional Agent Workflow**:
1. LLM triggers CLI to search files (grep/find)
2. Read files to find callers — missing context, search again
3. Read more files, hit token limits
4. Answer after 10+ slow iterations

**Typocop Workflow**:
1. Query: "Impact of UserService upstream?"
2. Pre-structured response: 8 callers, 3 clusters, 90%+ confidence
3. Complete and accurate answer in 1 query

### Key Benefits

- **Reliability**: LLM can't miss context—it's already in the tool response
- **Token Efficiency**: No 10-query chains to understand one function
- **Model Democratization**: Smaller LLMs work because tools do the heavy lifting
- **Confidence Scoring**: 90%+ confidence on production queries eliminates guesswork
- **Risk Assessment**: Automatic blast radius analysis (LOW/MEDIUM/HIGH/CRITICAL)

### Six-Phase Indexing Pipeline

1. **Structure**: Walk file tree, map folder/file relationships
2. **Parsing**: Extract functions, classes, methods, interfaces via Tree-sitter ASTs
3. **Resolution**: Resolve imports, calls, inheritance across files
4. **Clustering**: Group related symbols into functional communities (90%+ confidence)
5. **Processes**: Trace execution flows from entry points through call chains
6. **Search**: Build hybrid indexes (vector + keyword) for fast retrieval

## Sequence Diagrams

### Code Indexing Flow

```mermaid
sequenceDiagram
    participant User
    participant CLI
    participant Parser
    participant Indexer
    participant GraphDB
    participant VectorDB

    User->>CLI: parse --path ./src --lang php
    CLI->>Parser: initTreeSitter("php")
    Parser->>Indexer: Phase 1: walkFileTree(./src)
    Indexer->>Indexer: Phase 2: extractAST(files)
    Indexer->>Indexer: Phase 3: resolveReferences()
    Indexer->>Indexer: Phase 4: clusterSymbols()
    Indexer->>Indexer: Phase 5: traceProcesses()
    Indexer->>VectorDB: Phase 6: buildSearchIndex()
    Indexer->>GraphDB: storeGraph(nodes, edges)
    GraphDB-->>CLI: indexComplete(stats)
    CLI-->>User: Indexed 1,234 symbols, 5,678 relationships
```

### Natural Language Query Flow

```mermaid
sequenceDiagram
    participant Editor
    participant MCP
    participant QueryServer
    participant NLProcessor
    participant VectorDB
    participant GraphDB

    Editor->>MCP: query("What breaks if I change CustomerRepository?")
    MCP->>QueryServer: POST /query { text }
    QueryServer->>NLProcessor: parseIntent(text)
    NLProcessor->>VectorDB: semanticSearch("CustomerRepository")
    VectorDB-->>NLProcessor: [CustomerRepository, CustomerResourceModel, ...]
    NLProcessor->>GraphDB: findDependents(CustomerRepository)
    GraphDB-->>NLProcessor: [callers, flows, clusters]
    NLProcessor->>QueryServer: formatResponse(results)
    QueryServer-->>MCP: { affected: [...], risk: "medium" }
    MCP-->>Editor: Display impact analysis
```

### MCP Integration Flow

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant Kiro as Kiro (AI Editor)
    participant MCP as MCP Server
    participant QS as Query Server
    participant Graph as Neo4j Graph DB

    Dev->>Kiro: "What calls CustomerRepository::save and what breaks if I change it?"

    Note over Kiro: Identifies symbol: CustomerRepository::save<br/>Selects tool: impact_analysis

    Kiro->>MCP: impact_analysis({ symbolName: "CustomerRepository::save" })
    MCP->>QS: POST /query { text: "impact of CustomerRepository::save", intent: "impactAnalysis" }
    QS->>Graph: MATCH (s:Symbol {name:"CustomerRepository::save"})<-[:CALLS*]-(dep) RETURN dep
    Graph-->>QS: [AccountManagement, CustomerPlugin, CreatePost, ...]
    QS->>Graph: MATCH (s)-[:BELONGS_TO]->(c:Cluster) RETURN c
    Graph-->>QS: [CustomerCluster (confidence: 95%), RepositoryCluster (confidence: 88%)]
    QS->>Graph: MATCH (s)-[:PART_OF]->(p:Process) RETURN p
    Graph-->>QS: [CustomerRegistrationFlow (8 steps), CustomerUpdateFlow (5 steps)]
    QS-->>MCP: { symbols: [...], clusters: [...], processes: [...], riskLevel: "high", confidence: 0.94 }
    MCP-->>Kiro: Structured MCP response with complete context

    Kiro-->>Dev: "CustomerRepository::save is called by AccountManagement, CustomerPlugin, and CreatePost.<br/>Changing it will affect CustomerRegistrationFlow and CustomerUpdateFlow.<br/>Risk: HIGH. Recommend testing both flows end-to-end."
```
