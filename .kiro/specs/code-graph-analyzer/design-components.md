# Design: Components & Interfaces

Part of the [Code Graph Analyzer Design](./design.md).

## Component 1: CLI Tool

**Purpose**: Entry point for parsing source code and triggering the indexing pipeline

**Interface**:
```typescript
type Language =
  | "php" | "typescript" | "javascript" | "python" | "java"
  | "go" | "rust" | "c" | "cpp" | "csharp" | "ruby" | "swift";

interface CLIConfig {
  sourcePath: string;
  language: Language;
  outputPath?: string;
  verbose: boolean;
}

type CLICommand =
  | { type: "parse"; config: CLIConfig }
  | { type: "reindex"; dbPath: string }
  | { type: "status" };

function executeCLI(command: CLICommand): Promise<void>;
```

**Responsibilities**:
- Accept user commands for code parsing
- Validate input paths and language selection
- Initialize tree-sitter parser for target language
- Trigger multi-phase indexing pipeline
- Report progress and statistics

## Component 2: AST Parser

**Purpose**: Parse source code into Abstract Syntax Trees using tree-sitter

**Interface**:
```typescript
import Parser from "tree-sitter";

interface ASTNode {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: ASTNode[];
  text: string;
}

function initParser(language: Language): Parser;
function parseFile(parser: Parser, filePath: string): Promise<ASTNode | null>;
function extractSymbols(node: ASTNode, filePath: string): Symbol[];
```

**Responsibilities**:
- Initialize language-specific tree-sitter grammars
- Parse source files into AST representations
- Extract symbols (functions, classes, methods, interfaces)
- Handle parsing errors gracefully

## Component 3: Multi-Phase Indexer

**Purpose**: Transform ASTs into a knowledge graph through six phases

**Interface**:
```typescript
interface FileNode {
  path: string;
  language: Language;
  symbols: Symbol[];
}

type RelationType = "calls" | "imports" | "inherits" | "implements" | "contains" | "references" | "defines";

interface PipelineConfig {
  readonly sourcePath: string;
  readonly language: Language;
  readonly verbose: boolean;
  readonly graphSession: Session;
  readonly vectorPool: Pool;
  readonly aiClient?: AIClient;
}

interface PipelineResult {
  readonly symbols: Symbol[];
  readonly relationships: Relationship[];
  readonly clusters: Cluster[];
  readonly processes: Process[];
  readonly skippedFiles: number;
}

// Main pipeline orchestrator
function runIndexingPipeline(config: PipelineConfig): Promise<PipelineResult>;

// Phase 1: Structure
function walkFileTree(rootPath: string): Promise<FileNode[]>;

// Phase 2: Parsing
function extractAllSymbols(fileNodes: FileNode[]): Promise<Symbol[]>;

// Phase 3: Resolution
function resolveReferences(symbols: Symbol[]): Relationship[];

// Phase 4: Clustering
function clusterSymbols(symbols: Symbol[], rels: Relationship[], aiClient?: AIClient): Promise<Cluster[]>;

// Phase 5: Processes
function traceProcesses(symbols: Symbol[], rels: Relationship[]): Process[];

// Phase 6: Search
function buildSearchIndex(symbols: Symbol[], clusters: Cluster[], embedFn: (text: string) => Promise<Embedding | null>): Promise<void>;
```

**Responsibilities**:
- Orchestrate all 6 phases sequentially with progress logging
- Phase 1: Walk file tree and map folder/file relationships
- Phase 2: Extract functions, classes, methods, interfaces from ASTs
- Phase 3: Resolve imports, calls, inheritance across files
- Phase 4: Group related symbols into functional communities
- Phase 5: Trace execution flows from entry points through call chains
- Phase 6: Build hybrid search indexes for fast retrieval
- Store all results in Neo4j (graph nodes/edges) and pgvector (embeddings)
- Handle empty results gracefully at each phase
- Track skipped files and provide detailed statistics

## Component 4: Graph Database Interface

**Purpose**: Store and query the code knowledge graph using Neo4j

**Interface**:
```typescript
import neo4j, { Session } from "neo4j-driver";

interface GraphNode {
  id: string;
  labels: string[];
  properties: Record<string, string>;
}

interface GraphEdge {
  source: string;
  target: string;
  relType: string;
  properties: Record<string, string>;
}

function storeNodes(session: Session, nodes: GraphNode[]): Promise<void>;
function storeEdges(session: Session, edges: GraphEdge[]): Promise<void>;
function findNode(session: Session, id: string): Promise<GraphNode | null>;
function findDependents(session: Session, symbolId: string): Promise<GraphNode[]>;
function findDependencies(session: Session, symbolId: string): Promise<GraphNode[]>;
function traversePath(session: Session, from: string, to: string): Promise<GraphEdge[][]>;
```

**Responsibilities**:
- Store symbols as graph nodes with labels and properties
- Store relationships as graph edges with types
- Support graph traversal queries (dependents, dependencies, paths)
- Enforce maximum traversal depth to prevent infinite loops

## Component 5: Vector Store Interface

**Purpose**: Enable semantic search over code symbols using pgvector

**Interface**:
```typescript
import { Pool } from "pg";
import OpenAI from "openai";

interface Embedding {
  vector: number[];   // 3072 dimensions
  dimensions: number; // always 3072
}

interface SearchResult {
  symbolId: string;
  score: number;
  metadata: Record<string, string>;
}

function embedText(client: OpenAI, text: string): Promise<Embedding>;
function indexSymbol(pool: Pool, symbolId: string, text: string, embedding: Embedding): Promise<void>;
function semanticSearch(pool: Pool, client: OpenAI, query: string, limit: number): Promise<SearchResult[]>;
```

**Responsibilities**:
- Generate embeddings using OpenAI text-embedding-3-large (3072 dims)
- Store embeddings in PostgreSQL with pgvector (HNSW index)
- Perform semantic similarity search with sub-100ms target
- Return results ordered by descending similarity score

## Component 6: Query Server

**Purpose**: Process natural language queries and return structured results via HTTP API

**Interface**:
```typescript
import Fastify from "fastify";

interface Query {
  text: string;
  context?: string;
  maxResults: number;
}

type QueryIntent =
  | { type: "impactAnalysis";   target: string }
  | { type: "smartSearch";      query: string }
  | { type: "contextRetrieval"; target: string }
  | { type: "dataFlowTrace";    entryPoint: string }
  | { type: "preCommitCheck";   changedFiles: string[] };

type RiskLevel = "low" | "medium" | "high" | "critical";

interface QueryResult {
  intent: QueryIntent;
  symbols: Symbol[];
  relationships: Relationship[];
  clusters: Cluster[];
  processes: Process[];
  confidence: number;    // Target: 0.90+ for production
  riskLevel: RiskLevel;
  affectedFlows: string[];
}

function parseQueryIntent(text: string): Promise<QueryIntent>;
function executeQuery(query: Query): Promise<QueryResult>;
function formatResponse(result: QueryResult): string;
```

**Responsibilities**:
- Parse and classify natural language query intent (confidence >= 0.7)
- Combine semantic search with graph traversal
- Calculate confidence scores and risk levels
- Enforce maxResults limit and query timeout

## Component 7: MCP Server

**Purpose**: Integrate with AI editors via Model Context Protocol

**Interface**:
```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface MCPRequest {
  method: string;
  params: Record<string, string>;
}

interface MCPResponse {
  result: string;
  metadata: Record<string, string>;
}

function handleMCPRequest(request: MCPRequest): Promise<MCPResponse>;
function registerTools(server: McpServer): void;
function registerPrompts(server: McpServer): void;
```

**MCP Tools registered**:
```typescript
// get_symbol_context — 360° context: callers, callees, clusters, processes
{ name: "get_symbol_context", inputSchema: { symbolName: string, filePath?: string } }

// find_dependents — direct + transitive callers
{ name: "find_dependents", inputSchema: { symbolName: string, maxDepth?: number } }

// trace_data_flow — API endpoint → services → DB models
{ name: "trace_data_flow", inputSchema: { entryPoint: string, framework?: string } }

// impact_analysis — blast radius: affected symbols, flows, risk level
{ name: "impact_analysis", inputSchema: { symbolName: string, changeType?: "modify" | "delete" | "rename" } }
```

**MCP Tool Response Shape** (every tool returns this):
```typescript
interface MCPToolResponse {
  symbols: Array<{ id: string; name: string; kind: SymbolKind; location: { filePath: string; startLine: number }; relationship: string }>;
  clusters: Array<{ id: string; name: string; category: ClusterCategory; confidence: number }>;
  processes: Array<{ id: string; name: string; stepNumber: number; totalSteps: number }>;
  confidence: number;       // 0.0–1.0, target >= 0.90
  riskLevel: RiskLevel;
  affectedFlows: string[];
  summary: string;          // REQUIRED — human-readable, used directly by AI editors
}
```

**Responsibilities**:
- Implement MCP protocol specification with token-based authentication
- Register tools and prompts on startup
- Validate requests, return typed errors for malformed input
- Forward valid requests to Query Server and format responses

## Component 8: AI Context Enrichment

**Purpose**: Enhance graph data with AI-powered semantic analysis

**Interface**:
```typescript
interface EnrichmentConfig {
  embeddingModel: string;  // "text-embedding-3-large"
  dimensions: number;      // 3072
  enableIntentClassification: boolean;
  enableSideEffectAnalysis: boolean;
  enableTypeInference: boolean;
}

type EnrichmentTask =
  | { type: "dependencyMapping";      symbols: Symbol[] }
  | { type: "intentClassification";   text: string }
  | { type: "sideEffectAnalysis";     symbol: Symbol }
  | { type: "typeInference";          symbol: Symbol };

function enrichCluster(cluster: Cluster, config: EnrichmentConfig): Promise<Cluster>;
function classifyIntent(text: string): Promise<QueryIntent>;
function analyzeSideEffects(symbol: Symbol): Promise<string[]>;
function inferTypes(symbol: Symbol): Promise<Record<string, string>>;
```

**Responsibilities**:
- Generate semantic embeddings for symbols and clusters
- Classify query intent with confidence >= 0.7
- Analyze function side effects and mutations
- Infer types for dynamic languages (PHP, Python, JavaScript)
- Generate descriptive cluster names from symbol semantics
