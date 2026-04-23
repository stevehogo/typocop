/**
 * Database adapter interfaces and shared types.
 *
 * These interfaces decouple the query layer and indexer from the underlying
 * database engine, enabling migration to LadybugDB.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */

import type { Embedding, SearchResult } from "../types/index.js";

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

  queryNodes(
    label: string,
    filter?: Record<string, unknown>,
  ): Promise<GraphNode[]>;

  queryRelationships(type: string): Promise<GraphRelationship[]>;

  deleteNodesByLabel(label: string): Promise<number>;

  deleteRelationshipsByType(type: string): Promise<number>;

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

  semanticSearch(
    queryEmbedding: Embedding,
    limit: number,
  ): Promise<SearchResult[]>;

  deleteAll(): Promise<number>;
}

/**
 * Pluggable embedding generation — Ollama when enabled, NoOp when disabled.
 * Requirement 1.4
 */
export interface EmbeddingAdapter {
  isEnabled(): boolean;
  embedText(text: string): Promise<Embedding | null>;
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
}
