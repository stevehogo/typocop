# Design: Data Models & Algorithms

Part of the [Code Graph Analyzer Design](./design.md).

## Data Models

### Framework Support Model

```typescript
type TracingLevel = "full" | "partial" | "developing";

interface FrameworkSupport {
  framework: string;
  language: Language;
  apiEndpoints: boolean;   // Route parsing capability
  controllers: boolean;    // Controller module & route linking
  dbModels: boolean;       // Direct entity/model discovery
  supportedORMs: string[];
  tracingLevel: TracingLevel;
}

const supportedFrameworks: FrameworkSupport[] = [
  { framework: "Magento 2",   language: "php",        apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["Magento ORM"],                   tracingLevel: "full"    },
  { framework: "NestJS",      language: "typescript", apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["Prisma", "TypeORM"],             tracingLevel: "full"    },
  { framework: "Laravel",     language: "php",        apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["Eloquent"],                      tracingLevel: "full"    },
  { framework: "Express",     language: "javascript", apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["Prisma", "TypeORM", "Mongoose"], tracingLevel: "partial" },
  { framework: "Fastify",     language: "javascript", apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["Prisma", "TypeORM", "Mongoose"], tracingLevel: "partial" },
  { framework: "Spring Boot", language: "java",       apiEndpoints: true,  controllers: true,  dbModels: true,  supportedORMs: ["JPA", "Hibernate"],              tracingLevel: "partial" },
  { framework: "FastAPI",     language: "python",     apiEndpoints: true,  controllers: false, dbModels: true,  supportedORMs: ["SQLAlchemy"],                    tracingLevel: "partial" },
  { framework: "Django",      language: "python",     apiEndpoints: true,  controllers: false, dbModels: true,  supportedORMs: ["Django ORM"],                    tracingLevel: "partial" },
];
```

**Validation Rules**:
- At least one of `apiEndpoints`, `controllers`, or `dbModels` must be `true`
- `supportedORMs` must not be empty if `dbModels` is `true`
- `tracingLevel === "full"` requires all three capabilities to be `true`
- `tracingLevel === "partial"` requires at least one but not all capabilities to be `true`

### Symbol Model

```typescript
interface Location {
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

type Visibility = "public" | "private" | "protected" | "internal";
type Modifier  = "static" | "abstract" | "async" | "const" | "readonly";
type SymbolKind = "function" | "class" | "method" | "interface" | "variable" | "import" | "export" | "type";

interface Symbol {
  readonly id: string;            // unique across all symbols
  readonly name: string;          // non-empty
  readonly kind: SymbolKind;
  readonly location: Location;
  readonly signature?: string;
  readonly documentation?: string;
  readonly visibility: Visibility;
  readonly modifiers: Modifier[];
}
```

**Validation Rules**:
- `id` must be unique across all symbols
- `name` must be a non-empty string
- `location.startLine <= location.endLine`
- `location.startColumn <= location.endColumn` when on the same line

### Relationship Model

```typescript
type RelationType = "calls" | "imports" | "inherits" | "implements" | "contains" | "references" | "defines";

interface Relationship {
  readonly id: string;
  readonly source: string;   // Symbol ID — must exist
  readonly target: string;   // Symbol ID — must exist
  readonly relType: RelationType;
  readonly metadata: Record<string, string>;  // "unresolved": "true" for unresolved imports
}
```

**Validation Rules**:
- `source` and `target` must reference existing Symbol IDs
- `source !== target` (no self-references except recursive calls)

### Cluster Model

```typescript
type ClusterCategory =
  | "authentication" | "dataAccess" | "businessLogic"
  | "uiComponent" | "utility" | "unknown";

interface Cluster {
  readonly id: string;
  readonly name: string;
  readonly symbols: string[];   // Symbol IDs — min 2 entries
  readonly confidence: number;  // [0.0, 1.0] — target 0.90+ for production
  readonly category: ClusterCategory;
}
```

**Validation Rules**:
- `confidence` must be in range `[0.0, 1.0]`
- `symbols` must contain at least 2 entries
- All symbol IDs must reference existing symbols

### Process Model

```typescript
interface ProcessStep {
  readonly order: number;       // 0-indexed, sequential, no gaps
  readonly symbolId: string;    // must exist
  readonly description: string;
}

interface DataFlowEdge {
  readonly from: string;        // Symbol ID
  readonly to: string;          // Symbol ID
  readonly dataType?: string;
}

interface Process {
  readonly id: string;
  readonly name: string;
  readonly entryPoint: string;    // Symbol ID — must exist
  readonly steps: ProcessStep[];  // min 2 steps, ordered by `order`
  readonly dataFlow: DataFlowEdge[];
}
```

**Validation Rules**:
- `steps[i].order === i` for all i (sequential, no gaps)
- `steps.length >= 2`
- All symbol IDs must reference existing symbols

---

## Algorithmic Pseudocode

### Phase 1: File Tree Walking

```typescript
async function walkFileTree(rootPath: string): Promise<FileNode[]> {
  const fileNodes: FileNode[] = [];
  const entries = await fs.readdir(rootPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      fileNodes.push(...await walkFileTree(fullPath));  // recursive
    } else if (isSourceFile(fullPath)) {
      fileNodes.push({ path: fullPath, language: detectLanguage(fullPath), symbols: [] });
    }
  }
  return fileNodes;
}
// Preconditions:  rootPath exists and is readable
// Postconditions: returns all source files in tree
// Loop Invariant: fileNodes contains all processed files so far
```

### Phase 2: Symbol Extraction

```typescript
async function extractAllSymbols(fileNodes: FileNode[]): Promise<Symbol[]> {
  const allSymbols: Symbol[] = [];
  for (const fileNode of fileNodes) {
    const parser = initParser(fileNode.language);
    const ast = await parseFile(parser, fileNode.path);
    if (!ast) continue; // skip unparseable files
    allSymbols.push(...extractSymbolsFromAST(ast, fileNode.path));
  }
  return allSymbols;
}

function extractSymbolsFromAST(node: ASTNode, filePath: string): Symbol[] {
  const symbols: Symbol[] = [];
  if (isSymbolNode(node)) symbols.push(createSymbol(node, filePath));
  for (const child of node.children) symbols.push(...extractSymbolsFromAST(child, filePath));
  return symbols;
}
// Preconditions:  fileNodes contains valid file paths
// Postconditions: returns all extractable symbols
// Loop Invariant: allSymbols contains symbols from all processed files
```

### Phase 3: Reference Resolution

```typescript
async function resolveReferences(symbols: Symbol[]): Promise<Relationship[]> {
  const relationships: Relationship[] = [];
  const symbolMap = buildSymbolMap(symbols);

  for (const symbol of symbols) {
    for (const imp of findImports(symbol)) {
      const targetId = resolveImport(imp, symbolMap);
      relationships.push({
        id: generateId(), source: symbol.id,
        target: targetId ?? "__unresolved__",
        relType: "imports",
        metadata: targetId ? {} : { unresolved: "true" },
      });
    }
    for (const call of findCalls(symbol)) {
      const targetId = resolveCall(call, symbolMap);
      if (targetId) relationships.push({ id: generateId(), source: symbol.id, target: targetId, relType: "calls", metadata: {} });
    }
  }
  return relationships;
}
// Preconditions:  symbols list is non-empty
// Postconditions: returns all resolvable relationships
// Loop Invariant: relationships contains all resolved refs so far
```

### Phase 4: Symbol Clustering

```typescript
async function clusterSymbols(symbols: Symbol[], rels: Relationship[]): Promise<Cluster[]> {
  const graph = buildGraph(symbols, rels);
  const communities = louvainClustering(graph);  // Louvain community detection
  const clusters: Cluster[] = [];

  for (let idx = 0; idx < communities.length; idx++) {
    const community = communities[idx];
    const symbolIds = community.map(s => s.id);
    clusters.push({
      id: `cluster_${idx}`,
      name: await inferClusterName(symbolIds),
      symbols: symbolIds,
      confidence: calculateConfidence(community),
      category: await classifyCluster(symbolIds),
    });
  }
  return clusters;
}
// Preconditions:  symbols and rels are non-empty
// Postconditions: returns clusters with confidence >= 0.5
// Loop Invariant: clusters contains all processed communities
```

### Phase 5: Process Tracing

```typescript
async function traceProcesses(symbols: Symbol[], rels: Relationship[]): Promise<Process[]> {
  const entryPoints = findEntryPoints(symbols);
  const callGraph = buildCallGraph(rels);
  const processes: Process[] = [];

  for (const entry of entryPoints) {
    const steps = traceExecution(entry, callGraph, new Set<string>(), []);
    if (steps.length < 2) continue; // minimum process length
    processes.push({
      id: generateId(),
      name: inferProcessName(entry, steps),
      entryPoint: entry.id,
      steps,
      dataFlow: analyzeDataFlow(steps, rels),
    });
  }
  return processes;
}

function traceExecution(current: Symbol, graph: CallGraph, visited: Set<string>, path: ProcessStep[]): ProcessStep[] {
  if (visited.has(current.id)) return path; // cycle detected
  visited.add(current.id);
  const newPath = [...path, { order: path.length, symbolId: current.id, description: current.name }];
  const callees = graph.getCallees(current.id);
  if (callees.length === 0) return newPath;
  return traceExecution(callees[0], graph, visited, newPath);
}
// Preconditions:  symbols contains entry points
// Postconditions: returns processes with >= 2 steps
// Loop Invariant: visited set prevents infinite recursion
```

### Phase 6: Search Index Building

```typescript
async function buildSearchIndex(symbols: Symbol[], clusters: Cluster[]): Promise<SearchIndex> {
  const index = new SearchIndex();

  for (const symbol of symbols) {
    const text = formatSymbolForEmbedding(symbol);
    const embedding = await embedText(openaiClient, text);
    await index.addSymbol(symbol.id, text, embedding);
  }
  for (const cluster of clusters) {
    const text = formatClusterForEmbedding(cluster);
    const embedding = await embedText(openaiClient, text);
    await index.addCluster(cluster.id, text, embedding);
  }
  for (const symbol of symbols) {
    for (const keyword of extractKeywords(symbol)) {
      index.addKeyword(keyword, symbol.id);
    }
  }
  return index;
}
// Preconditions:  symbols and clusters are non-empty
// Postconditions: returns searchable hybrid index (vector + keyword)
// Loop Invariant: index contains all processed items
```

---

## Key Functions: Formal Specifications

### parseQueryIntent

**Preconditions**: `queryText` is non-empty; query server is initialized  
**Postconditions**: Returns valid `QueryIntent`; classification confidence >= 0.7; no side effects

### executeQuery

**Preconditions**: `query.text` non-empty; Neo4j and pgvector accessible; `query.maxResults > 0`  
**Postconditions**: `result.symbols.length <= query.maxResults`; `result.confidence` in `[0.0, 1.0]`; all symbol IDs exist in DB; `result.affectedFlows` lists all impacted processes

### findDependents

**Preconditions**: `symbolId` references existing symbol; Neo4j session active  
**Postconditions**: Returns all direct + transitive dependents; no duplicates; traversal depth <= configured maximum  
**Loop Invariant**: visited set prevents cycles

### traceDataFlow

**Preconditions**: `entrySymbolId` references existing entry point symbol; call graph accessible  
**Postconditions**: Returns complete path from entry to DB models; edges ordered by execution sequence; no cycles  
**Loop Invariant**: visited set prevents infinite loops
