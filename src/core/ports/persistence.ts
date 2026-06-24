/**
 * Database adapter interfaces and shared types.
 *
 * These interfaces decouple the query layer and indexer from the underlying
 * database engine, enabling migration to LadybugDB.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */

import type { Embedding, SearchResult } from "../domain.js";

// ─── Graph Types ──────────────────────────────────────────────────────────────

/** Database-agnostic graph node representation. */
export interface GraphNode {
  readonly id: string;
  readonly labels: readonly string[];
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Safely extract a string property from a GraphNode, with fallback. */
export function prop(node: GraphNode, key: string, fallback = ""): string {
  const v = node.properties[key];
  return typeof v === "string" ? v : fallback;
}

/** Database-agnostic graph relationship representation. */
export interface GraphRelationship {
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly sourceId?: string;
  readonly targetId?: string;
}

// ─── Adapter Interfaces ───────────────────────────────────────────────────────

/**
 * Abstracts graph database operations (node/relationship CRUD, Cypher queries).
 * Requirement 1.2
 */
export interface GraphAdapter {
  createNode(
    label: string,
    properties: Record<string, unknown>,
  ): Promise<void>;

  createRelationship(
    fromId: string,
    toId: string,
    type: string,
    properties?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * OPTIONAL batch fast-path for inserting many nodes that share a single
   * `label`. When implemented, callers may hand an adapter one chunk of
   * same-label rows per call instead of looping {@link createNode}. When this
   * method is ABSENT, callers MUST fall back to per-row {@link createNode}; the
   * stored result is identical either way (same prefixing — adapter-owned, same
   * properties). Grouping is single-label by design, matching how the indexing
   * pipeline already groups its writes (Symbol/Cluster/Process/...). Chunk sizes
   * are bounded by the caller (see DB_WRITE_BATCH_SIZE).
   */
  createNodes?(
    label: string,
    nodes: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void>;

  /**
   * OPTIONAL batch fast-path for inserting many relationships that share a
   * single `type`. When implemented, callers may hand an adapter one chunk of
   * same-type edges per call instead of looping {@link createRelationship}.
   * When this method is ABSENT, callers MUST fall back to per-row
   * {@link createRelationship}; the stored result is identical either way.
   * Grouping is single-type by design (the pipeline groups by relationship
   * type, e.g. CONTAINS / HAS_STEP / DEPENDS_ON). Chunk sizes are bounded by the
   * caller (see DB_WRITE_BATCH_SIZE).
   */
  createRelationships?(
    type: string,
    relationships: ReadonlyArray<{
      readonly fromId: string;
      readonly toId: string;
      readonly properties?: Record<string, unknown>;
    }>,
  ): Promise<void>;

  /**
   * Returns all nodes matching `label` and `filter`. Callers that may read large
   * graphs should prefer paged `runCypher` queries with explicit SKIP/LIMIT
   * windows; connection-server responses are intentionally bounded by gRPC
   * limits.
   */
  queryNodes(
    label: string,
    filter?: Record<string, unknown>,
  ): Promise<GraphNode[]>;

  /**
   * Returns all relationships of `type`. Callers that may read large graphs
   * should prefer paged `runCypher` queries with explicit SKIP/LIMIT windows;
   * connection-server responses are intentionally bounded by gRPC limits.
   */
  queryRelationships(type: string): Promise<GraphRelationship[]>;

  deleteNodesByLabel(label: string): Promise<number>;

  deleteRelationshipsByType(type: string): Promise<number>;

  /**
   * OPTIONAL diff-write fast-path (A4): DETACH DELETE every `Symbol` node whose
   * `filePath` is in `paths`, returning the number of symbol nodes deleted.
   * `DETACH DELETE` transiently drops inbound cross-file edges too; the indexing
   * pipeline re-emits those edges every run from the global resolution (keyed by
   * `logicalKey`), so they restore — this is why v1 keeps resolution global.
   *
   * When this method is ABSENT, callers MUST fall back to a full refresh
   * (deleteNodesByLabel for every label). The remote/gRPC adapter intentionally
   * omits it so it degrades to full-refresh.
   */
  deleteSymbolsByFilePaths?(paths: readonly string[]): Promise<number>;

  runCypher<T>(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<T[]>;

  runCypherWrite(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Abstracts vector storage and semantic search operations.
 * Requirement 1.3
 */
export interface VectorAdapter {
  createTables(): Promise<void>;

  indexSymbol(
    symbolId: string,
    embedding: Embedding,
    metadata?: Record<string, string>,
  ): Promise<void>;

  /**
   * OPTIONAL batch fast-path for indexing many symbol embeddings at once. When
   * implemented, callers may hand an adapter one chunk of entries per call
   * instead of looping {@link indexSymbol}. When this method is ABSENT, callers
   * MUST fall back to per-row {@link indexSymbol}; the stored result is
   * identical either way. Chunk sizes are bounded by the caller (see
   * DB_WRITE_BATCH_SIZE).
   */
  indexSymbols?(
    entries: ReadonlyArray<{
      readonly symbolId: string;
      readonly embedding: Embedding;
      readonly metadata?: Record<string, string>;
    }>,
  ): Promise<void>;

  semanticSearch(
    queryEmbedding: Embedding,
    limit: number,
  ): Promise<SearchResult[]>;

  deleteAll(): Promise<number>;

  /**
   * OPTIONAL diff-write fast-path (A4): delete every embedding row whose stored
   * `file_path` column is in `paths`, returning the number of rows deleted. The
   * adapter writes that column from `metadata.filePath` on each index call, so
   * per-file vector deletes are a clean indexed match (no JSON_EXTRACT scan).
   *
   * When this method is ABSENT, callers MUST fall back to a full refresh
   * (deleteAll). The remote/gRPC adapter intentionally omits it so it degrades
   * to full-refresh.
   */
  deleteByFilePaths?(paths: readonly string[]): Promise<number>;
}

/**
 * Pluggable embedding generation — Ollama when enabled, NoOp when disabled.
 * Requirement 1.4
 */
export interface EmbeddingAdapter {
  isEnabled(): boolean;
  embedText(text: string): Promise<Embedding | null>;

  /**
   * OPTIONAL batch fast-path: embed many texts in one call so per-item fixed
   * inference overhead is amortized across a single forward pass. Returns one
   * result per input, INDEX-ALIGNED to `texts` (result[i] ↔ texts[i]), with
   * `null` for any item that fails PRE-INFERENCE validation (privacy/length).
   *
   * IMPORTANT semantics (see embeddings performance plan, Phase 1):
   * - Per-item `null` is only produced by pre-inference validation failures.
   *   The underlying inference call is all-or-nothing — a genuine inference
   *   error (OOM/malformed tensor/timeout) REJECTS the whole call rather than
   *   nulling a single index. Callers MUST therefore treat a thrown/timed-out
   *   `embedTexts` as "the whole batch is suspect" and fall back to per-item
   *   {@link embedText}.
   * - When this method is ABSENT, callers MUST fall back to per-item
   *   {@link embedText}; the stored result is identical either way (modulo tiny
   *   batched-vs-single float drift). NoOp / Ollama / custom adapters need no
   *   change.
   */
  embedTexts?(texts: string[]): Promise<(Embedding | null)[]>;

  getDimensions(): number;
}

/**
 * Unified entry point combining graph, vector, and embedding adapters.
 * Requirement 1.1
 */
export interface DatabaseAdapter {
  initialize(): Promise<void>;
  close(): Promise<void>;
  getGraphAdapter(): GraphAdapter;
  getVectorAdapter(): VectorAdapter;
  getEmbeddingAdapter(): EmbeddingAdapter;

  /**
   * OPTIONAL: re-establish/warm the underlying connection so the next write
   * lands on a live channel. Callers invoke this right before a heavy write
   * phase that may follow a long compute window with no DB traffic (e.g. the
   * `--pdg` persist boundary). The remote/gRPC adapter re-readies its channels;
   * the embedded adapter has no channel to warm and omits it (callers use
   * `ensureReady?.()` so the absence is a no-op).
   */
  ensureReady?(): Promise<void>;
}
