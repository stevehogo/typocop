# Requirements Document

## Introduction

The Code Graph Analyzer is a precomputed relational intelligence system that transforms source code into a queryable knowledge graph. The system provides complete and precise context in a single query with 90%+ confidence, eliminating the need for iterative text searches and multiple query chains that traditional AI agents rely on. The primary supported framework is Magento 2 (PHP e-commerce), with full tracing support including webapi.xml route parsing, Controller/Action classes, Model/ResourceModel/Collection pattern, Repository pattern, Plugin/interceptor detection, Event/Observer pattern, and di.xml dependency injection. Additional frameworks include NestJS, Laravel, Express, Fastify, Spring Boot, FastAPI, and Django.

## Related Design Documents

- [Architecture & Diagrams](./design.md)
- [Components & Interfaces](./design-components.md)
- [Data Models & Algorithms](./design-data-models.md)
- [Use Cases & Correctness Properties](./design-correctness.md)

## Glossary

- **System**: The Code Graph Analyzer application
- **CLI_Tool**: Command-line interface for code ingestion and indexing
- **AST_Parser**: Abstract Syntax Tree parser using Tree-sitter
- **Indexer**: Multi-phase pipeline that transforms ASTs into knowledge graph
- **Graph_Database**: Storage system for code relationships (Neo4j or similar)
- **Vector_Store**: Semantic search database (PostgreSQL with pgvector)
- **Query_Server**: Service that processes natural language queries
- **MCP_Server**: Model Context Protocol server for editor integration
- **Symbol**: Code entity (function, class, method, interface, variable)
- **Relationship**: Connection between symbols (calls, imports, inherits, etc.)
- **Cluster**: Group of related symbols forming a functional community
- **Process**: Execution flow traced from entry point through call chains
- **Confidence_Score**: Numerical measure of result accuracy (0.0 to 1.0)
- **Risk_Level**: Impact assessment (LOW, MEDIUM, HIGH, CRITICAL)
- **Framework**: Backend framework with specialized parsing support
- **Tracing_Level**: Degree of data flow support (Full, Partial, Developing)
- **AI_Enrichment**: Component that enhances graph data with AI-powered semantic analysis
- **Pre_Commit_Check**: Query type that analyzes blast radius of changed files before committing

## Requirements

### Requirement 1: CLI Code Parsing

**User Story:** As a developer, I want to parse my source code via CLI, so that I can build a knowledge graph of my codebase.

#### Acceptance Criteria

1. WHEN a user executes the parse command with a valid source path and language, THE CLI_Tool SHALL initiate the indexing pipeline
2. WHEN a user provides an invalid source path, THE CLI_Tool SHALL return an error message indicating the path does not exist
3. WHEN a user specifies an unsupported language, THE CLI_Tool SHALL return an error message listing supported languages
4. WHEN indexing completes successfully, THE CLI_Tool SHALL report statistics including symbol count and relationship count
5. WHERE verbose mode is enabled, THE CLI_Tool SHALL display progress information during indexing
6. WHEN a user executes the reindex command with a valid database path, THE CLI_Tool SHALL re-run the indexing pipeline against the existing database
7. WHEN a user executes the status command, THE CLI_Tool SHALL report the current state of the knowledge graph including symbol count, relationship count, and last indexed timestamp

### Requirement 2: Multi-Language AST Parsing

**User Story:** As a developer, I want to parse code in multiple programming languages, so that I can analyze polyglot codebases.

#### Acceptance Criteria

1. THE AST_Parser SHALL support parsing TypeScript source files
2. THE AST_Parser SHALL support parsing JavaScript source files
3. THE AST_Parser SHALL support parsing Python source files
4. THE AST_Parser SHALL support parsing PHP source files
5. THE AST_Parser SHALL support parsing Java source files
6. THE AST_Parser SHALL support parsing Go source files
7. THE AST_Parser SHALL support parsing Rust source files
8. THE AST_Parser SHALL support parsing C source files
9. THE AST_Parser SHALL support parsing C++ source files
10. THE AST_Parser SHALL support parsing C# source files
11. THE AST_Parser SHALL support parsing Ruby source files
12. THE AST_Parser SHALL support parsing Swift source files
13. WHEN a source file contains syntax errors, THE AST_Parser SHALL log a warning and skip the file
14. WHEN a source file is successfully parsed, THE AST_Parser SHALL extract all symbols including functions, classes, methods, interfaces, and variables

### Requirement 3: Six-Phase Indexing Pipeline

**User Story:** As a developer, I want my code to be systematically indexed through multiple phases, so that I get complete and accurate knowledge graph data.

#### Acceptance Criteria

1. WHEN indexing begins, THE Indexer SHALL execute Phase 1 to walk the file tree and map folder/file relationships
2. WHEN Phase 1 completes, THE Indexer SHALL execute Phase 2 to extract symbols from ASTs
3. WHEN Phase 2 completes, THE Indexer SHALL execute Phase 3 to resolve imports, calls, and inheritance across files
4. WHEN Phase 3 completes, THE Indexer SHALL execute Phase 4 to cluster related symbols into functional communities
5. WHEN Phase 4 completes, THE Indexer SHALL execute Phase 5 to trace execution flows from entry points
6. WHEN Phase 5 completes, THE Indexer SHALL execute Phase 6 to build hybrid search indexes
7. WHEN any phase fails, THE Indexer SHALL log the error and halt the pipeline
8. WHEN all phases complete, THE Indexer SHALL store the knowledge graph in the Graph_Database and Vector_Store

### Requirement 4: Symbol Extraction and Storage

**User Story:** As a developer, I want all code symbols to be extracted and stored, so that I can query relationships between them.

#### Acceptance Criteria

1. WHEN a symbol is extracted, THE Indexer SHALL assign it a unique identifier
2. WHEN a symbol is extracted, THE Indexer SHALL record its name, kind, location, signature, and visibility
3. WHEN symbols are stored, THE Graph_Database SHALL ensure no duplicate symbol identifiers exist
4. WHEN a symbol location is recorded, THE Indexer SHALL ensure start line is less than or equal to end line
5. WHEN a symbol location is on a single line, THE Indexer SHALL ensure start column is less than or equal to end column

### Requirement 5: Relationship Resolution

**User Story:** As a developer, I want cross-file references to be resolved, so that I can understand dependencies between modules.

#### Acceptance Criteria

1. WHEN an import statement is found, THE Indexer SHALL create a relationship with type Imports
2. WHEN a function call is found, THE Indexer SHALL create a relationship with type Calls
3. WHEN class inheritance is found, THE Indexer SHALL create a relationship with type Inherits
4. WHEN interface implementation is found, THE Indexer SHALL create a relationship with type Implements
5. WHEN a relationship is created, THE Indexer SHALL ensure both source and target symbols exist
6. IF an import cannot be resolved, THEN THE Indexer SHALL create the relationship with metadata flag unresolved set to true
7. WHEN a relationship is stored, THE Graph_Database SHALL validate that source and target symbol identifiers reference existing symbols

### Requirement 6: Symbol Clustering

**User Story:** As a developer, I want related symbols to be grouped into clusters, so that I can understand functional communities in my codebase.

#### Acceptance Criteria

1. WHEN clustering begins, THE Indexer SHALL apply community detection algorithms to group related symbols
2. WHEN a cluster is created, THE Indexer SHALL assign it a confidence score between 0.0 and 1.0
3. WHEN a cluster is created, THE Indexer SHALL classify it into a category (Authentication, DataAccess, BusinessLogic, UIComponent, Utility, or Unknown)
4. WHEN a cluster is created, THE Indexer SHALL ensure it contains at least 2 symbols
5. WHEN a cluster is stored, THE Graph_Database SHALL validate that all symbol identifiers reference existing symbols
6. WHEN clustering completes, THE AI_Enrichment SHALL generate descriptive names for each cluster using semantic analysis

### Requirement 7: Process Tracing

**User Story:** As a developer, I want execution flows to be traced from entry points, so that I can understand complete call chains.

#### Acceptance Criteria

1. WHEN process tracing begins, THE Indexer SHALL identify entry point symbols (API endpoints, main functions, controllers)
2. WHEN an entry point is found, THE Indexer SHALL perform depth-first traversal through the call graph
3. WHEN a circular dependency is detected, THE Indexer SHALL terminate traversal and mark the process as cyclic
4. WHEN a process is created, THE Indexer SHALL record steps in sequential order
5. WHEN a process is created, THE Indexer SHALL analyze data flow between steps
6. WHEN a process has fewer than 2 steps, THE Indexer SHALL exclude it from storage
7. WHEN process tracing completes, THE Indexer SHALL store all processes with their entry points, steps, and data flow edges

### Requirement 8: Hybrid Search Index

**User Story:** As a developer, I want fast semantic and keyword search, so that I can quickly find relevant code symbols.

#### Acceptance Criteria

1. WHEN search indexing begins, THE Indexer SHALL generate embeddings for all symbols using an embedding model
2. WHEN search indexing begins, THE Indexer SHALL generate embeddings for all clusters
3. WHEN embeddings are generated, THE Vector_Store SHALL store them with 3072 dimensions
4. WHEN search indexing begins, THE Indexer SHALL extract keywords from symbol names and signatures
5. WHEN keywords are extracted, THE Indexer SHALL create keyword-to-symbol mappings
6. IF the embedding service is unavailable, THEN THE Indexer SHALL fall back to keyword-only indexing and log a warning

### Requirement 9: Natural Language Query Processing

**User Story:** As a developer, I want to query my codebase using natural language, so that I can get answers without writing complex queries.

#### Acceptance Criteria

1. WHEN a query is received, THE Query_Server SHALL parse the query text to determine intent
2. WHEN query intent is classified, THE Query_Server SHALL assign a confidence score of at least 0.7
3. WHEN a query is processed, THE Query_Server SHALL combine semantic search with graph traversal
4. WHEN query results are generated, THE Query_Server SHALL calculate a confidence score between 0.0 and 1.0
5. WHEN query results are generated, THE Query_Server SHALL assign a risk level (LOW, MEDIUM, HIGH, or CRITICAL)
6. WHEN query results are returned, THE Query_Server SHALL limit the number of symbols to the specified maximum
7. WHEN query results have confidence of 0.90 or higher, THE Query_Server SHALL ensure all referenced symbol identifiers exist in the database

### Requirement 10: Impact Analysis Queries

**User Story:** As a developer, I want to analyze the impact of changing a function, so that I can understand what will break before making changes.

#### Acceptance Criteria

1. WHEN an impact analysis query is received, THE Query_Server SHALL identify the target symbol
2. WHEN the target symbol is identified, THE Query_Server SHALL find all direct and transitive dependents
3. WHEN dependents are found, THE Query_Server SHALL identify all affected business processes
4. WHEN the risk level is LOW, THE Query_Server SHALL ensure 0 to 2 symbols are affected
5. WHEN the risk level is MEDIUM, THE Query_Server SHALL ensure 3 to 10 symbols are affected
6. WHEN the risk level is HIGH, THE Query_Server SHALL ensure 11 or more symbols are affected
7. WHEN the risk level is CRITICAL, THE Query_Server SHALL ensure core system components are affected
8. WHEN impact analysis completes, THE Query_Server SHALL return affected symbols, processes, and risk assessment

### Requirement 11: Smart Search Queries

**User Story:** As a developer, I want to search for code by functionality, so that I can find complete execution flows instead of random file matches.

#### Acceptance Criteria

1. WHEN a smart search query is received, THE Query_Server SHALL perform semantic search to find relevant symbols
2. WHEN relevant symbols are found, THE Query_Server SHALL group them by cluster
3. WHEN clusters are identified, THE Query_Server SHALL retrieve associated processes
4. WHEN processes are retrieved, THE Query_Server SHALL order process steps sequentially
5. WHEN smart search completes, THE Query_Server SHALL return clusters with their symbols and execution flows

### Requirement 11b: Pre-Commit Check Queries

**User Story:** As a developer, I want to analyze the blast radius of my uncommitted changes, so that I can understand the risk before committing.

#### Acceptance Criteria

1. WHEN a pre-commit check query is received, THE Query_Server SHALL identify all symbols defined in the changed files
2. WHEN changed symbols are identified, THE Query_Server SHALL find all direct and transitive dependents of those symbols
3. WHEN dependents are found, THE Query_Server SHALL identify all affected business processes
4. WHEN pre-commit check completes, THE Query_Server SHALL return affected symbols, processes, and a risk assessment
5. WHEN pre-commit check completes, THE Query_Server SHALL include recommendations for which flows to test

### Requirement 12: Context Retrieval Queries

**User Story:** As a developer, I want to see all relationships for a function, so that I can understand its complete context.

#### Acceptance Criteria

1. WHEN a context retrieval query is received, THE Query_Server SHALL identify the target symbol
2. WHEN the target symbol is identified, THE Query_Server SHALL find all symbols that call it
3. WHEN the target symbol is identified, THE Query_Server SHALL find all symbols it calls
4. WHEN the target symbol is identified, THE Query_Server SHALL find all processes it participates in
5. WHEN the target symbol is identified, THE Query_Server SHALL find all clusters it belongs to
6. WHEN context retrieval completes, THE Query_Server SHALL return callers, callees, processes, and clusters

### Requirement 13: Data Flow Tracing Queries

**User Story:** As a developer, I want to trace data flow from API endpoints to database models, so that I can understand end-to-end data paths.

#### Acceptance Criteria

1. WHEN a data flow tracing query is received, THE Query_Server SHALL identify the entry point symbol
2. WHEN the entry point is an API endpoint, THE Query_Server SHALL trace through controllers
3. WHEN controllers are identified, THE Query_Server SHALL trace through service layers
4. WHEN service layers are identified, THE Query_Server SHALL trace through repository layers
5. WHEN repository layers are identified, THE Query_Server SHALL identify database models
6. WHEN data flow tracing completes, THE Query_Server SHALL return the complete path from entry to database
7. WHERE the framework has Full tracing level, THE Query_Server SHALL ensure API endpoints, controllers, and database models are all present in the trace

### Requirement 14: Framework-Specific Parsing

**User Story:** As a developer, I want framework-specific features to be parsed, so that I can trace data flow in my framework of choice.

#### Acceptance Criteria

1. WHEN parsing a Magento 2 project, THE AST_Parser SHALL extract REST and GraphQL endpoints from webapi.xml, Controller/Action classes from Controller/ directories, Model/ResourceModel/Collection patterns, Repository interfaces and implementations, Plugin (interceptor) before/after/around methods, Event dispatch and Observer registrations, and dependency injection configuration from di.xml
2. WHEN parsing a NestJS project, THE AST_Parser SHALL extract route decorators, dependency injection, and Prisma/TypeORM models
3. WHEN parsing a Laravel project, THE AST_Parser SHALL extract route definitions, Eloquent models, and controller methods
4. WHEN parsing an Express project, THE AST_Parser SHALL extract route handlers, middleware chains, and ORM integrations
5. WHEN parsing a Fastify project, THE AST_Parser SHALL extract route handlers, middleware chains, and ORM integrations
6. WHEN parsing a Spring Boot project, THE AST_Parser SHALL extract REST controller annotations, JPA entities, and Hibernate models
7. WHEN parsing a FastAPI project, THE AST_Parser SHALL extract route decorators and SQLAlchemy models
8. WHEN parsing a Django project, THE AST_Parser SHALL extract URL patterns and Django ORM models
9. WHEN a framework has Full tracing level, THE AST_Parser SHALL support API endpoints, controllers, and database models
10. WHEN a framework has Partial tracing level, THE AST_Parser SHALL support at least one of API endpoints, controllers, or database models

### Requirement 15: MCP Server Integration

**User Story:** As a developer, I want to use the system from my AI editor, so that I can query my codebase without leaving my development environment.

#### Acceptance Criteria

1. WHEN the MCP_Server starts, THE MCP_Server SHALL register available tools for querying, analyzing, and tracing
2. WHEN the MCP_Server starts, THE MCP_Server SHALL register available prompts
3. WHEN an MCP request is received, THE MCP_Server SHALL validate the request format
4. IF an MCP request is malformed, THEN THE MCP_Server SHALL return an error response with validation details
5. WHEN a valid MCP request is received, THE MCP_Server SHALL forward it to the Query_Server
6. WHEN the Query_Server returns results, THE MCP_Server SHALL format them according to MCP protocol
7. WHEN an MCP response is sent, THE MCP_Server SHALL maintain the connection state for subsequent requests
8. WHEN an MCP tool response is returned, THE MCP_Server SHALL include a human-readable summary field alongside structured symbol, cluster, and process data

### Requirement 16: Graph Database Operations

**User Story:** As a developer, I want graph data to be stored efficiently, so that queries execute quickly.

#### Acceptance Criteria

1. WHEN symbols are stored, THE Graph_Database SHALL create nodes with labels and properties
2. WHEN relationships are stored, THE Graph_Database SHALL create edges with types and properties
3. WHEN a symbol is queried by identifier, THE Graph_Database SHALL return the matching node within 100ms
4. WHEN dependents are queried, THE Graph_Database SHALL traverse edges to find all symbols that depend on the target
5. WHEN dependencies are queried, THE Graph_Database SHALL traverse edges to find all symbols the target depends on
6. WHEN a path is queried between two symbols, THE Graph_Database SHALL return all possible paths
7. WHEN graph traversal is performed, THE Graph_Database SHALL enforce a maximum depth limit to prevent infinite loops

### Requirement 17: Vector Store Operations

**User Story:** As a developer, I want semantic search to be fast and accurate, so that I can find relevant code quickly.

#### Acceptance Criteria

1. WHEN embeddings are stored, THE Vector_Store SHALL index them for approximate nearest neighbor search
2. WHEN a semantic search is performed, THE Vector_Store SHALL return results within 100ms
3. WHEN semantic search results are returned, THE Vector_Store SHALL include similarity scores
4. WHEN semantic search results are returned, THE Vector_Store SHALL order them by descending similarity score
5. WHEN semantic search is performed, THE Vector_Store SHALL use HNSW algorithm for sub-100ms performance

### Requirement 18: Error Handling for Unparseable Files

**User Story:** As a developer, I want indexing to continue when some files have syntax errors, so that I can still analyze the rest of my codebase.

#### Acceptance Criteria

1. WHEN a source file cannot be parsed, THE AST_Parser SHALL log a warning with the file path and error details
2. WHEN a source file cannot be parsed, THE AST_Parser SHALL skip the file and continue with the next file
3. WHEN indexing completes with skipped files, THE CLI_Tool SHALL report the count of skipped files to the user

### Requirement 19: Error Handling for Database Failures

**User Story:** As a developer, I want the system to handle database failures gracefully, so that I receive clear error messages.

#### Acceptance Criteria

1. IF the Graph_Database connection fails, THEN THE System SHALL retry with exponential backoff for up to 3 attempts
2. IF all Graph_Database connection attempts fail, THEN THE System SHALL return an error message to the user
3. IF the Vector_Store connection fails, THEN THE System SHALL retry with exponential backoff for up to 3 attempts
4. IF all Vector_Store connection attempts fail, THEN THE System SHALL return an error message to the user

### Requirement 20: Performance Targets

**User Story:** As a developer, I want queries to execute quickly, so that I can maintain my development flow.

#### Acceptance Criteria

1. WHEN a simple query is executed, THE Query_Server SHALL return results within 500ms
2. WHEN a complex graph traversal is executed, THE Query_Server SHALL return results within 2 seconds
3. WHEN indexing is performed, THE Indexer SHALL process at least 10,000 lines of code per second
4. WHEN semantic search is performed, THE Vector_Store SHALL return results within 100ms
5. WHEN a symbol is queried by identifier, THE Graph_Database SHALL return results within 100ms

### Requirement 21: Confidence Score Accuracy

**User Story:** As a developer, I want confidence scores to be accurate, so that I can trust the query results.

#### Acceptance Criteria

1. WHEN query results are generated, THE Query_Server SHALL calculate confidence based on symbol resolution completeness
2. WHEN query results are generated, THE Query_Server SHALL ensure the confidence score is in the range 0.0 to 1.0
3. WHEN query results have confidence of 0.90 or higher, THE Query_Server SHALL ensure at least one symbol is returned
4. WHEN query results have confidence of 0.90 or higher, THE Query_Server SHALL ensure all symbol identifiers exist in the database
5. WHEN clusters are created, THE Indexer SHALL assign confidence scores based on community detection algorithm metrics
6. WHEN query intent is classified, THE Query_Server SHALL assign confidence of at least 0.7

### Requirement 22: Security and Privacy

**User Story:** As a developer, I want my code to remain private, so that sensitive information is not exposed.

#### Acceptance Criteria

1. THE System SHALL perform all parsing and indexing locally without sending code to external services
2. WHERE an external embedding service is used, THE System SHALL send only symbol signatures and not full code
3. WHEN natural language queries are processed, THE Query_Server SHALL sanitize input before executing graph database queries
4. WHEN file paths are processed during indexing, THE System SHALL validate paths to prevent directory traversal attacks
5. WHEN the MCP_Server accepts connections, THE MCP_Server SHALL implement token-based authentication

### Requirement 23: Resource Limits

**User Story:** As a developer, I want the system to enforce resource limits, so that it does not consume excessive resources.

#### Acceptance Criteria

1. WHEN a file is processed during indexing, THE System SHALL enforce a maximum file size limit
2. WHEN the knowledge graph is built, THE System SHALL enforce a maximum graph size limit
3. WHEN a query is executed, THE Query_Server SHALL enforce a timeout limit
4. WHEN graph traversal is performed, THE System SHALL enforce a maximum traversal depth limit

### Requirement 24: AI Context Enrichment

**User Story:** As a developer, I want code symbols and clusters to be enriched with AI-powered semantic analysis, so that queries return meaningful business context.

#### Acceptance Criteria

1. WHEN a cluster is created, THE AI_Enrichment SHALL generate a descriptive name for the cluster using semantic analysis of its symbols
2. WHEN a cluster is enriched, THE AI_Enrichment SHALL classify it into a category (Authentication, DataAccess, BusinessLogic, UIComponent, Utility, or Unknown)
3. WHEN query intent is classified, THE AI_Enrichment SHALL return a confidence score of at least 0.7
4. WHEN a symbol is analyzed, THE AI_Enrichment SHALL identify its side effects and mutations
5. WHERE type inference is enabled, THE AI_Enrichment SHALL infer types for symbols in dynamically typed languages

### Requirement 25: Framework Support Validation

**User Story:** As a developer, I want framework support to be consistently defined, so that data flow tracing behaves predictably across frameworks.

#### Acceptance Criteria

1. WHEN a framework is registered, THE System SHALL ensure at least one of API endpoints, controllers, or database models is supported
2. WHEN a framework is registered with database model support, THE System SHALL ensure at least one ORM is listed in its supported ORMs
3. WHEN a framework is registered with Full tracing level, THE System SHALL ensure API endpoints, controllers, and database models are all enabled
4. WHEN a framework is registered with Partial tracing level, THE System SHALL ensure at least one but not all of API endpoints, controllers, or database models is enabled
