# Data Models

All core types live in `src/types/index.ts`. Never redefine these inline — always import from there.

## Symbol

```typescript
type SymbolKind = "function" | "class" | "method" | "interface" | "variable" | "import" | "export" | "type";
type Visibility = "public" | "private" | "protected" | "internal";
type Modifier = "static" | "abstract" | "async" | "const" | "readonly";

interface Location {
  readonly filePath: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

interface Symbol {
  readonly id: string;           // unique across all symbols
  readonly name: string;         // non-empty
  readonly kind: SymbolKind;
  readonly location: Location;
  readonly signature?: string;
  readonly documentation?: string;
  readonly visibility: Visibility;
  readonly modifiers: Modifier[];
}
```

**Invariants**: `id` unique, `name` non-empty, `startLine <= endLine`, `startColumn <= endColumn` on same line.

## Relationship

```typescript
type RelationType = "calls" | "imports" | "inherits" | "implements" | "contains" | "references" | "defines";

interface Relationship {
  readonly id: string;
  readonly source: string;   // Symbol ID — must exist
  readonly target: string;   // Symbol ID — must exist
  readonly relType: RelationType;
  readonly metadata: Record<string, string>;  // use "unresolved": "true" for unresolved imports
}
```

**Invariants**: `source` and `target` must reference existing Symbol IDs. `source !== target` except for recursive calls.

## Cluster

```typescript
type ClusterCategory = "authentication" | "dataAccess" | "businessLogic" | "uiComponent" | "utility" | "unknown";

interface Cluster {
  readonly id: string;
  readonly name: string;
  readonly symbols: string[];    // Symbol IDs — min 2 entries
  readonly confidence: number;   // [0.0, 1.0]
  readonly category: ClusterCategory;
}
```

**Invariants**: `confidence` in `[0.0, 1.0]`, `symbols.length >= 2`, all symbol IDs must exist.

## Process

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
  readonly entryPoint: string;  // Symbol ID — must exist
  readonly steps: ProcessStep[];  // min 2 steps, ordered by `order`
  readonly dataFlow: DataFlowEdge[];
}
```

**Invariants**: `steps[i].order === i` for all i, `steps.length >= 2`, all symbol IDs must exist.

## Query Types

```typescript
interface Query {
  readonly text: string;         // non-empty
  readonly context?: string;
  readonly maxResults: number;   // > 0
}

type QueryIntent =
  | { type: "impactAnalysis";   target: string }
  | { type: "smartSearch";      query: string }
  | { type: "contextRetrieval"; target: string }
  | { type: "dataFlowTrace";    entryPoint: string }
  | { type: "preCommitCheck";   changedFiles: string[] };

type RiskLevel = "low" | "medium" | "high" | "critical";

interface QueryResult {
  readonly intent: QueryIntent;
  readonly symbols: Symbol[];
  readonly relationships: Relationship[];
  readonly clusters: Cluster[];
  readonly processes: Process[];
  readonly confidence: number;      // [0.0, 1.0], target >= 0.90 for production
  readonly riskLevel: RiskLevel;
  readonly affectedFlows: string[];
}
```

**Risk level thresholds**: `low` = 0–2 affected symbols, `medium` = 3–10, `high` = 11+, `critical` = core components affected.

## MCP Tool Response

```typescript
interface MCPToolResponse {
  symbols: Array<{
    id: string;
    name: string;
    kind: SymbolKind;
    location: { filePath: string; startLine: number };
    relationship: string;
  }>;
  clusters: Array<{
    id: string;
    name: string;
    category: ClusterCategory;
    confidence: number;
  }>;
  processes: Array<{
    id: string;
    name: string;
    stepNumber: number;
    totalSteps: number;
  }>;
  confidence: number;
  riskLevel: RiskLevel;
  affectedFlows: string[];
  summary: string;   // REQUIRED — human-readable, used directly by AI editors
}
```

**`summary` is mandatory** on every MCP tool response (Req 15.8).

## Framework Support

```typescript
type TracingLevel = "full" | "partial" | "developing";

interface FrameworkSupport {
  readonly framework: string;
  readonly language: Language;
  readonly apiEndpoints: boolean;
  readonly controllers: boolean;
  readonly dbModels: boolean;
  readonly supportedORMs: string[];
  readonly tracingLevel: TracingLevel;
}
```

**Invariants**:
- At least one of `apiEndpoints`, `controllers`, `dbModels` must be `true`
- `supportedORMs` must be non-empty when `dbModels` is `true`
- `tracingLevel === "full"` requires all three capabilities to be `true`
- `tracingLevel === "partial"` requires at least one but not all capabilities to be `true`

## Embedding

```typescript
interface Embedding {
  readonly vector: number[];    // exactly 1536 elements
  readonly dimensions: number;  // always 1536
}

interface SearchResult {
  readonly symbolId: string;
  readonly score: number;       // similarity score, results ordered descending
  readonly metadata: Record<string, string>;
}
```

**Invariants**: `vector.length === 1536`, `dimensions === 1536`, search results ordered by descending `score`.
