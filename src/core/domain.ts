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
  // startLine/startColumn/endLine are MUTABLE (A1): a symbol moving within its
  // file changes these without changing its persisted identity (`logicalKey`).
  startLine: number;
  startColumn: number;
  endLine: number;
  readonly endColumn: number;
}

export interface Symbol {
  readonly id: string;           // intra-run dedup/lookup key (position-INCLUSIVE)
  /**
   * Stable, position-INDEPENDENT persisted identity (A1, KEYSTONE). Derived from
   * (filePath, qualifiedName, kind, per-file ordinal) — survives a symbol moving
   * within its file. THE shared identity contract: all PERSISTED node ids, edge
   * source/target, cluster/process/vector symbol refs map to `logicalKey` (see
   * {@link persistedKey}), while `id` stays the intra-run dedup/lookup key.
   */
  readonly logicalKey: string;
  readonly name: string;         // non-empty
  readonly kind: SymbolKind;
  readonly location: Location;
  readonly signature?: string;
  readonly documentation?: string;
  readonly visibility: Visibility;
  readonly modifiers: Modifier[];
  // ── E1 deeper-resolution carriers (OPTIONAL; additive) ───────────────────
  // Populated by the parsing layer for functions/methods/constructors so the
  // resolution `SymbolTable` can expose `{ returnType, parameterCount }` for
  // MRO-aware member-call resolution and chain binding. Absent ⇒ behaviour is
  // identical to before (golden edge output unchanged).
  /** Raw return-type text from the AST (e.g. `User`, `Promise<User>`). */
  readonly returnType?: string;
  /** Declared parameter count for a callable symbol. */
  readonly parameterCount?: number;
  /**
   * Intra-run `id` of the owning class/struct/interface for a method or
   * constructor (E1). Threads method→owner so MRO can walk a class's methods.
   */
  readonly ownerId?: string;
  /**
   * Per-callable complexity metrics (E2). Populated by the parsing layer for
   * function/method/constructor defs (where the live tree-sitter `Tree`
   * exists). Absent for non-callable symbols and where unsupported ⇒ Symbol
   * shape stays identical to pre-E2 (golden output unchanged).
   */
  readonly complexity?: ComplexityMetrics;
  /**
   * API contract drift carriers (E3; OPTIONAL, additive). Populated only for the
   * relevant route/consumer symbols by the framework parsers — absent everywhere
   * else, so the Symbol shape stays pre-E3 identical.
   */
  /**
   * Top-level keys of the JSON body a route handler returns
   * (`res.json({...})` / `res.send({...})` / `return {...}`). Attached to route
   * Symbols (Express/NestJS). Used by `shape_check` to detect contract drift.
   */
  readonly responseKeys?: readonly string[];
  /**
   * Property keys a consumer symbol reads off a fetched value (`result.data`,
   * `result.total`). Recorded from the E3 `member.access` capture. Used by
   * `shape_check` to flag reads of keys no route returns.
   */
  readonly accessedKeys?: readonly string[];
  // ── Wave 2 export-detection carrier (OPTIONAL; additive) ─────────────────
  /**
   * Whether the symbol is exported/public in its language, as determined by the
   * per-language export-detection table (`infrastructure/parsing/export-detection.ts`).
   * ORTHOGONAL to {@link visibility} — `isExported` answers "is this reachable
   * from outside its module/file?" (TS `export`, Go uppercase, Rust `pub`,
   * Python non-`_`, C non-`static`), whereas `visibility` answers the
   * access-modifier axis (`public`/`private`/…). Absent ⇒ consumers fall back to
   * the pre-Wave-2 `visibility === "public"` heuristic (golden output unchanged).
   * Feeds the entry-point export ×2 multiplier and dead-code detection.
   */
  readonly isExported?: boolean;
  // ── Wave 2 entry-point classification carriers (OPTIONAL; additive) ──────
  /**
   * Classification of an entry-point symbol (1.1). Populated only for symbols
   * that score above the entry-point threshold; absent everywhere else, so the
   * Symbol shape stays pre-Wave-2 identical. Persisted as the `entryPointKind`
   * node prop.
   */
  readonly entryPointKind?: EntryPointKind;
  /**
   * Human-readable explainability trail for an entry-point symbol's score (1.1),
   * e.g. `base:2.00, exported, entry-pattern, framework:nextjs-api-route`.
   * Populated alongside {@link entryPointKind}; persisted as the
   * `entryPointReason` node prop.
   */
  readonly entryPointReason?: string;
}

/**
 * Entry-point kind classification (Wave 2, 1.1). Produced by
 * `inferEntryPointKind` (`platform/utils/entry-point-names.ts`) from a symbol's
 * name, file path, and scoring reasons. Surfaced on {@link Symbol.entryPointKind}
 * and persisted as a node property.
 */
export type EntryPointKind =
  | "main" | "route" | "task" | "event" | "lifecycle" | "test";

/**
 * Complexity metrics for a callable symbol (E2). Computed as a pure tree-sitter
 * subtree walk in `infrastructure/parsing/complexity.ts`; persisted on the
 * Symbol node as STRING props (`cyclomatic`/`cognitive`/`maxLoopDepth`).
 */
export interface ComplexityMetrics {
  /** McCabe cyclomatic complexity: 1 + number of decision nodes. */
  readonly cyclomatic: number;
  /** Nesting-weighted cognitive complexity. */
  readonly cognitive: number;
  /** Deepest nesting of loop constructs (0 = no loops). */
  readonly maxLoopDepth: number;
}

/**
 * The PERSISTED endpoint key for a symbol (A1). Returns the stable
 * position-independent `logicalKey`, falling back to the intra-run `id` only for
 * legacy/synthetic symbols that predate the keystone (so callers never emit an
 * empty endpoint). Use this — never `sym.id` — wherever a node id or an edge
 * endpoint is EMITTED or PERSISTED.
 */
export function persistedKey(sym: Pick<Symbol, "id" | "logicalKey">): string {
  return sym.logicalKey || sym.id;
}

// ─── Relationship ─────────────────────────────────────────────────────────────

export type RelationType =
  | "calls" | "imports" | "inherits" | "implements"
  | "contains" | "references" | "defines" | "dependsOn"
  // ── E1 MRO-derived edges (ADDITIVE) ──────────────────────────────────────
  // `overrides`: a subclass method overrides a method of the same name reachable
  //   via the linearised (C3/MRO) ancestor chain. NEVER replaces `inherits`.
  // `methodImplements`: a concrete method satisfies an interface/trait method
  //   contract. NEVER replaces `implements`.
  | "overrides" | "methodImplements";

export interface Relationship {
  readonly id: string;
  readonly source: string;   // Symbol ID — must exist
  readonly target: string;   // Symbol ID — must exist
  readonly relType: RelationType;
  readonly metadata: Record<string, string>; // "unresolved": "true" for unresolved imports
}

export type PackageEcosystem =
  | "npm"
  | "composer"
  | "pip"
  | "maven"
  | "cargo"
  | "go_modules"
  | "unknown";

export interface ExternalDependencyNode {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly ecosystem: PackageEcosystem;
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

/**
 * Structural role of a node in the call graph (D2 explainability). Classified
 * from hop-1 in/out degree + export status. Mirrors the application-layer
 * `NodeRole` (kept here so the wire response contract is self-contained in the
 * leaf domain module without an application→core cycle).
 */
export type NodeRole = "EntryPoint" | "Utility" | "CoreLogic" | "Isolated" | "Adapter";

export interface MCPToolResponse {
  symbols: Array<{
    id: string;
    name: string;
    kind: SymbolKind;
    location: { filePath: string; startLine: number };
    relationship: string;
    score?: number; // Semantic similarity score [0.0, 1.0]
    // ── D2 explainability (ADDITIVE; only populated by impact analysis) ──────
    /** Structural role of this affected node. */
    nodeRole?: NodeRole;
    /** First-hop edge type that pulled this node into the blast radius. */
    entryEdge?: RelationType;
    /** Number of edges from the target to this node (1 = direct caller). */
    hopDistance?: number;
    // ── E2 complexity hotspots (ADDITIVE; only populated by find_hotspots) ───
    /** Cyclomatic complexity of this symbol (find_hotspots only). */
    cyclomatic?: number;
    /** Cognitive complexity of this symbol (find_hotspots only). */
    cognitive?: number;
    /** Deepest loop nesting of this symbol (find_hotspots only). */
    maxLoopDepth?: number;
    // ── E3 contract drift (ADDITIVE; only populated by shape_check) ──────────
    /** Route response keys (route symbols, shape_check only). */
    responseKeys?: readonly string[];
    /** Consumer-read keys (consumer symbols, shape_check only). */
    accessedKeys?: readonly string[];
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
  // ── D3 trace (ADDITIVE; only populated by the `trace` tool) ────────────────
  /**
   * Shortest CALLS|CONTAINS hop chain between two symbols (D3). Absent for all
   * other tools, so the wire contract stays backward compatible.
   */
  trace?: {
    /** True when a path was found between the two resolved endpoints. */
    found: boolean;
    /** Number of EDGES on the path (`hops.length - 1`). */
    length: number;
    hops: Array<{
      symbolId: string;
      name: string;
      filePath: string;
      startLine: number;
      /** Edge type linking this hop to the next; absent on the final hop. */
      edgeToNext?: RelationType;
    }>;
  };
  // ── D4 token-budgeted slicing (ADDITIVE; only set when get_symbol_context is
  //    called with a tokenBudget). Absent otherwise → wire contract unchanged. ─
  /**
   * Why context slicing stopped: `complete` (everything fit), `token_budget`
   * (budget exhausted, some symbols dropped), or `max_depth` (depth limit hit).
   */
  truncationReason?: "complete" | "token_budget" | "max_depth";
  /** Sum of the per-symbol token estimates for the returned (sliced) symbols. */
  estimatedTokens?: number;
  // ── D5 coordinated rename (ADDITIVE; only populated by the `rename` tool).
  //    Absent for all other tools → wire contract unchanged. ─────────────────
  /**
   * A PREVIEW-ONLY rename plan (D5). `preview` is ALWAYS true — v1 never
   * mutates files or the graph; it returns a diff plan the caller can apply.
   */
  rename?: {
    /** INVARIANT: always true. No write/fs path exists in v1. */
    preview: true;
    oldName: string;
    newName: string;
    highConfidenceCount: number;
    lowConfidenceCount: number;
    /** Edge-backed, file:line-anchored edits (definition + references). */
    edits: Array<{
      filePath: string;
      line: number;
      confidence: "high" | "low";
      kind: "definition" | "reference";
    }>;
    /** Word-boundary regex descriptor for the low-confidence text tail. */
    lowConfidence: {
      pattern: string;
      flags: string;
      confidence: "low";
    };
  };
  // ── E3 API contract drift (ADDITIVE; only populated by `shape_check`).
  //    Absent for all other tools → wire contract unchanged. ─────────────────
  /**
   * Result of pairing route response shapes against consumer key reads (E3).
   * Each mismatch is a key a consumer reads that no matching route returns.
   */
  shapeCheck?: {
    /** Number of route↔consumer pairs that were compared. */
    pairsChecked: number;
    mismatches: Array<{
      /** Symbol id of the consumer that reads the missing key. */
      consumerId: string;
      consumerName: string;
      filePath: string;
      /** The key the consumer reads that no matching route returns. */
      key: string;
      /** Keys the route(s) actually return (sorted, for the diff message). */
      availableKeys: readonly string[];
      /** `low` when the consumer file fetches more than one route (R9). */
      confidence: "high" | "low";
    }>;
  };
  // ── Grounding API verify_claim (ADDITIVE; only populated by `verify_claim`).
  //    Absent for all other tools → wire contract unchanged. ──────────────────
  /**
   * Verdict for a structured claim about the codebase (anti-hallucination).
   * Honest-uncertainty: a relationship the graph cannot prove (dynamic dispatch,
   * callbacks, DI) is reported `uncertain`, never a false confirm/refute. On a
   * refute, `trueAnswer` carries the actual answer (e.g. the real caller set).
   */
  verdict?: {
    /** Which claim class was checked. */
    claimKind: "usage" | "edge" | "reachability";
    verdict: "confirmed" | "refuted" | "uncertain";
    /** Confidence in the verdict, [0.0, 1.0]. */
    confidence: number;
    reason: string;
    /** Supporting facts (caller names, edge types, hop chain, suggestions…). */
    evidence: string[];
    /** A concrete counterexample to the claim (only on a refute). */
    counterexample?: string;
    /** The actual answer surfaced on a refute (OQ3): caller set, hop path, … */
    trueAnswer?: string;
  };
  // ── Guarded read-only Cypher (ADDITIVE; only populated by `query_graph`,
  //    Wave 8 · T9). Absent for all other tools → wire contract unchanged. ────
  /**
   * Raw rows from a guarded, read-only, row-capped Cypher query. `ok` is false
   * when the query was rejected pre-execution (a write/DDL/multi-statement
   * input never runs); `unsupported` then carries the reason. `labels[]` / rel
   * `type` strings in rows have the persisted node/edge-label prefix stripped.
   */
  queryGraph?: {
    /** True when the query passed the read-only guardrails and executed. */
    ok: boolean;
    /** Returned rows (column-alias → value), capped at `limit`. */
    rows: ReadonlyArray<Record<string, unknown>>;
    /** Number of rows returned. */
    rowCount: number;
    /** Effective row cap applied. */
    limit: number;
    /** True when rows were truncated to the cap. */
    truncated: boolean;
    /** Rejection reason when `ok` is false (prefixed `unsupported: …`). */
    unsupported?: string;
  };
}

// ─── Search & Embeddings ──────────────────────────────────────────────────────

export interface Embedding {
  readonly vector: number[];   // length === dimensions
  readonly dimensions: number; // variable: depends on embedding model (e.g. 2560 for Ollama)
}

export interface SearchResult {
  readonly symbolId: string;
  readonly score: number;      // similarity score, results ordered descending
  readonly metadata: Record<string, string>;
}
