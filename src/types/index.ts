// Core data types for the Code Graph Analyzer
// All types live here — never redefine inline in other modules

// ─── Symbol ──────────────────────────────────────────────────────────────────

export type SymbolKind =
  | "function" | "class" | "method" | "interface"
  | "variable" | "import" | "export" | "type";

export type Visibility = "public" | "private" | "protected" | "internal";
export type Modifier = "static" | "abstract" | "async" | "const" | "readonly";

export interface Location {
  readonly filePath: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface Symbol {
  readonly id: string;           // unique across all symbols
  readonly name: string;         // non-empty
  readonly kind: SymbolKind;
  readonly location: Location;
  readonly signature?: string;
  readonly documentation?: string;
  readonly visibility: Visibility;
  readonly modifiers: Modifier[];
}

// ─── Relationship ─────────────────────────────────────────────────────────────

export type RelationType =
  | "calls" | "imports" | "inherits" | "implements"
  | "contains" | "references" | "defines";

export interface Relationship {
  readonly id: string;
  readonly source: string;   // Symbol ID — must exist
  readonly target: string;   // Symbol ID — must exist
  readonly relType: RelationType;
  readonly metadata: Record<string, string>; // "unresolved": "true" for unresolved imports
}

// ─── Cluster ──────────────────────────────────────────────────────────────────

export type ClusterCategory =
  | "authentication" | "dataAccess" | "businessLogic"
  | "uiComponent" | "utility" | "unknown";

export interface Cluster {
  readonly id: string;
  readonly name: string;
  readonly symbols: string[];   // Symbol IDs — min 2 entries
  readonly confidence: number;  // [0.0, 1.0]
  readonly category: ClusterCategory;
}

// ─── Process ──────────────────────────────────────────────────────────────────

export interface ProcessStep {
  readonly order: number;       // 0-indexed, sequential, no gaps
  readonly symbolId: string;    // must exist
  readonly description: string;
}

export interface DataFlowEdge {
  readonly from: string;        // Symbol ID
  readonly to: string;          // Symbol ID
  readonly dataType?: string;
}

export interface Process {
  readonly id: string;
  readonly name: string;
  readonly entryPoint: string;    // Symbol ID — must exist
  readonly steps: ProcessStep[];  // min 2 steps, ordered by `order`
  readonly dataFlow: DataFlowEdge[];
}

// ─── Framework Support ────────────────────────────────────────────────────────

export type Language =
  | "php" | "typescript" | "javascript" | "python" | "java"
  | "go" | "rust" | "c" | "cpp" | "csharp" | "ruby" | "swift";

export type TracingLevel = "full" | "partial" | "developing";

export interface FrameworkSupport {
  readonly framework: string;
  readonly language: Language;
  readonly apiEndpoints: boolean;
  readonly controllers: boolean;
  readonly dbModels: boolean;
  readonly supportedORMs: string[];
  readonly tracingLevel: TracingLevel;
}

// ─── Query Types ──────────────────────────────────────────────────────────────

export interface Query {
  readonly text: string;        // non-empty
  readonly context?: string;
  readonly maxResults: number;  // > 0
}

export type QueryIntent =
  | { type: "impactAnalysis";   target: string }
  | { type: "smartSearch";      query: string }
  | { type: "contextRetrieval"; target: string }
  | { type: "dataFlowTrace";    entryPoint: string }
  | { type: "preCommitCheck";   changedFiles: string[] };

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface QueryResult {
  readonly intent: QueryIntent;
  readonly symbols: Symbol[];
  readonly relationships: Relationship[];
  readonly clusters: Cluster[];
  readonly processes: Process[];
  readonly confidence: number;      // [0.0, 1.0], target >= 0.90 for production
  readonly riskLevel: RiskLevel;
  readonly affectedFlows: string[];
}

// ─── MCP Tool Response ────────────────────────────────────────────────────────

export interface MCPToolResponse {
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
  summary: string; // REQUIRED — human-readable, used directly by AI editors (Req 15.8)
}

// ─── Search & Embeddings ──────────────────────────────────────────────────────

export interface Embedding {
  readonly vector: number[];   // exactly 1536 elements
  readonly dimensions: number; // always 1536
}

export interface SearchResult {
  readonly symbolId: string;
  readonly score: number;      // similarity score, results ordered descending
  readonly metadata: Record<string, string>;
}
