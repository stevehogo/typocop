# Project Overview: Code Graph Analyzer (Typocop)

## What This Project Is

Typocop is a precomputed relational intelligence system that transforms source code into a queryable knowledge graph. It eliminates the need for iterative file searches by precomputing the entire code structure — clustering, tracing, and scoring — and delivering complete context in a single query with 90%+ confidence.

## Core Value Proposition

Traditional AI agents run 10+ queries to understand one function. Typocop answers in 1.

- **Reliability**: LLM can't miss context — it's already in the tool response
- **Token Efficiency**: No iterative searches, complete answers in one query
- **Model Democratization**: Smaller LLMs work because tools do the heavy lifting
- **Confidence Scoring**: 90%+ confidence on production queries
- **Risk Assessment**: Automatic blast radius analysis (LOW/MEDIUM/HIGH/CRITICAL)

## System Architecture

```
CLI Tool → AST Parser (tree-sitter) → 6-Phase Indexer → LadybugDB (Kùzu)
                                                              ↓
                                              Query Server (Fastify HTTP API)
                                                              ↓
                                              MCP Server (@modelcontextprotocol/sdk)
                                                              ↓
                                         AI Editors (Kiro, Claude, Cursor, Windsurf)
```

## Six-Phase Indexing Pipeline

1. **Structure** — Walk file tree, map folder/file relationships
2. **Parsing** — Extract symbols via Tree-sitter ASTs
3. **Resolution** — Resolve imports, calls, inheritance across files
4. **Clustering** — Group related symbols into functional communities (Louvain algorithm)
5. **Processes** — Trace execution flows from entry points through call chains
6. **Search** — Build hybrid indexes (vector + keyword) for fast retrieval

## Five Query Types

1. **Impact Analysis** — What breaks if I change X?
2. **Smart Search** — Find complete execution flows by functionality
3. **Context Retrieval** — 360° view of a symbol (callers, callees, clusters, processes)
4. **Data Flow Trace** — API endpoint → services → repository → database models
5. **Pre-Commit Check** — Blast radius of uncommitted changes

## Tech Stack

- **Language**: TypeScript
- **AST Parsing**: tree-sitter (12 languages)
- **Database**: LadybugDB (embedded Kùzu graph + vector storage)
- **Embeddings**: Ollama local embeddings (mxbai-embed-large, 1024 dimensions)
- **Query Server**: Fastify
- **MCP SDK**: @modelcontextprotocol/sdk
- **Property Testing**: fast-check

## Supported Languages

TypeScript, JavaScript, Python, PHP, Java, Go, Rust, C, C++, C#, Ruby, Swift

## Supported Frameworks

| Framework   | Language   | Tracing Level |
|-------------|------------|---------------|
| Magento 2   | PHP        | Full          |
| NestJS      | TypeScript | Full          |
| Laravel     | PHP        | Full          |
| Express     | JavaScript | Partial       |
| Fastify     | JavaScript | Partial       |
| Spring Boot | Java       | Partial       |
| FastAPI     | Python     | Partial       |
| Django      | Python     | Partial       |

## Spec Location

All spec documents are in `.kiro/specs/code-graph-analyzer/`:
- `requirements.md` — 25 requirements with acceptance criteria
- `design.md` — Architecture, system context, sequence diagrams
- `design-components.md` — Component interfaces and responsibilities
- `design-data-models.md` — Data models, algorithmic pseudocode, formal specs
- `design-correctness.md` — Use cases and 21 correctness properties
- `tasks.md` — 29 implementation tasks
