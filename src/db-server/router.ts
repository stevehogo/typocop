import { status } from "@grpc/grpc-js";

import { LadybugGraphAdapter } from "../db/ladybug-graph-adapter.js";
import { LadybugVectorAdapter } from "../db/ladybug-vector-adapter.js";
import type { GraphNode, GraphRelationship } from "../core/ports/persistence.js";
import type { Embedding, SearchResult } from "../core/domain.js";
import { InMemoryMetricsCollector, type MetricsCollector } from "./metrics.js";
import { logServerEvent } from "../platform/logging/logger.js";
import type { EmbeddedDatabaseRuntime } from "./runtime.js";
import type { RequestMetadata, RequestPriority, SchedulerStats, ServerMetrics } from "./types.js";

export type GraphOperation =
  | { readonly kind: "QueryNodes"; readonly metadata: RequestMetadata; readonly label: string; readonly filter?: Record<string, unknown>; readonly priority: RequestPriority }
  | { readonly kind: "QueryRelationships"; readonly metadata: RequestMetadata; readonly type: string; readonly priority: RequestPriority }
  | { readonly kind: "RunCypher"; readonly metadata: RequestMetadata; readonly query: string; readonly params?: Record<string, unknown>; readonly priority: RequestPriority }
  | { readonly kind: "RunCypherWrite"; readonly metadata: RequestMetadata; readonly query: string; readonly params?: Record<string, unknown>; readonly priority: RequestPriority }
  | { readonly kind: "CreateNode"; readonly metadata: RequestMetadata; readonly label: string; readonly properties: Record<string, unknown>; readonly priority: RequestPriority }
  | { readonly kind: "CreateRelationship"; readonly metadata: RequestMetadata; readonly fromId: string; readonly toId: string; readonly type: string; readonly properties?: Record<string, unknown>; readonly priority: RequestPriority }
  | { readonly kind: "DeleteNodesByLabel"; readonly metadata: RequestMetadata; readonly label: string; readonly priority: RequestPriority }
  | { readonly kind: "DeleteRelationshipsByType"; readonly metadata: RequestMetadata; readonly type: string; readonly priority: RequestPriority };

export type VectorOperation =
  | { readonly kind: "CreateTables"; readonly metadata: RequestMetadata; readonly priority: RequestPriority }
  | { readonly kind: "IndexSymbol"; readonly metadata: RequestMetadata; readonly symbolId: string; readonly embedding: Embedding; readonly metadataMap?: Record<string, string>; readonly priority: RequestPriority }
  | { readonly kind: "SemanticSearch"; readonly metadata: RequestMetadata; readonly queryEmbedding: Embedding; readonly limit: number; readonly priority: RequestPriority }
  | { readonly kind: "DeleteAll"; readonly metadata: RequestMetadata; readonly priority: RequestPriority };

export interface OperationRouter {
  routeGraphOp(op: GraphOperation, prefix: string): Promise<GraphNode[] | GraphRelationship[] | Record<string, unknown>[] | number | void>;
  routeVectorOp(op: VectorOperation, prefix: string): Promise<SearchResult[] | number | void>;
  getMetrics(): ServerMetrics;
  getSchedulerStats(): SchedulerStats;
}

export interface RequestScheduler {
  enqueue<T>(request: {
    readonly id: string;
    readonly priority: RequestPriority;
    readonly timeoutMs: number;
    readonly execute: () => Promise<T>;
  }): Promise<T>;
  stats(): SchedulerStats;
}

export class DefaultOperationRouter implements OperationRouter {
  private readonly graphAdapter: LadybugGraphAdapter;
  private readonly vectorAdapter: LadybugVectorAdapter;
  private readonly metrics: MetricsCollector;

  constructor(
    private readonly runtime: EmbeddedDatabaseRuntime,
    private readonly scheduler: RequestScheduler,
    private readonly prefix: string,
    metrics?: MetricsCollector,
  ) {
    this.graphAdapter = new LadybugGraphAdapter(runtime.getConnection(), prefix);
    this.vectorAdapter = new LadybugVectorAdapter(runtime.getConnection(), prefix);
    this.metrics = metrics || new InMemoryMetricsCollector({
      isDatabaseOpen: () => runtime.isHealthy(),
      getSchedulerStats: () => scheduler.stats(),
    });
  }

  async routeGraphOp(op: GraphOperation, prefix: string): Promise<GraphNode[] | GraphRelationship[] | Record<string, unknown>[] | number | void> {
    this.validateMetadata(op.metadata, prefix);
    switch (op.kind) {
      case "QueryNodes":
        this.requireNonEmpty(op.label, "label");
        return this.runGraphRequest(op.kind, op.metadata, op.priority, () =>
          this.graphAdapter.queryNodes(op.label, op.filter),
        );
      case "QueryRelationships":
        this.requireNonEmpty(op.type, "type");
        return this.runGraphRequest(op.kind, op.metadata, op.priority, () =>
          this.graphAdapter.queryRelationships(op.type),
        );
      case "RunCypher":
        this.requireNonEmpty(op.query, "query");
        return this.runGraphRequest(op.kind, op.metadata, op.priority, () =>
          this.graphAdapter.runCypher<Record<string, unknown>>(op.query, op.params),
        );
      case "RunCypherWrite":
        this.requireNonEmpty(op.query, "query");
        return this.runGraphRequest(op.kind, op.metadata, op.priority, () =>
          this.graphAdapter.runCypherWrite(op.query, op.params),
        );
      case "CreateNode":
        this.requireNonEmpty(op.label, "label");
        return this.runGraphRequest(op.kind, op.metadata, op.priority, () =>
          this.graphAdapter.createNode(op.label, op.properties),
        );
      case "CreateRelationship":
        this.requireNonEmpty(op.fromId, "fromId");
        this.requireNonEmpty(op.toId, "toId");
        this.requireNonEmpty(op.type, "type");
        return this.runGraphRequest(op.kind, op.metadata, op.priority, () =>
          this.graphAdapter.createRelationship(op.fromId, op.toId, op.type, op.properties),
        );
      case "DeleteNodesByLabel":
        this.requireNonEmpty(op.label, "label");
        return this.runGraphRequest(op.kind, op.metadata, op.priority, () =>
          this.graphAdapter.deleteNodesByLabel(op.label),
        );
      case "DeleteRelationshipsByType":
        this.requireNonEmpty(op.type, "type");
        return this.runGraphRequest(op.kind, op.metadata, op.priority, () =>
          this.graphAdapter.deleteRelationshipsByType(op.type),
        );
    }
  }

  async routeVectorOp(op: VectorOperation, prefix: string): Promise<SearchResult[] | number | void> {
    this.validateMetadata(op.metadata, prefix);
    switch (op.kind) {
      case "CreateTables":
        return this.runVectorRequest(op.kind, op.metadata, op.priority, () =>
          this.vectorAdapter.createTables(),
        );
      case "IndexSymbol":
        this.requireNonEmpty(op.symbolId, "symbolId");
        this.validateEmbedding(op.embedding);
        return this.runVectorRequest(op.kind, op.metadata, op.priority, () =>
          this.vectorAdapter.indexSymbol(op.symbolId, op.embedding, op.metadataMap),
        );
      case "SemanticSearch":
        this.validateEmbedding(op.queryEmbedding);
        if (!Number.isInteger(op.limit) || op.limit <= 0) {
          throw invalidArgument("limit must be a positive integer");
        }
        return this.runVectorRequest(op.kind, op.metadata, op.priority, () =>
          this.vectorAdapter.semanticSearch(op.queryEmbedding, op.limit),
        );
      case "DeleteAll":
        return this.runVectorRequest(op.kind, op.metadata, op.priority, () =>
          this.vectorAdapter.deleteAll(),
        );
    }
  }

  getMetrics(): ServerMetrics {
    return this.metrics.getMetrics();
  }

  getSchedulerStats(): SchedulerStats {
    return this.scheduler.stats();
  }

  private validateMetadata(metadata: RequestMetadata, prefix: string): void {
    if (!metadata || metadata.requestId.trim() === "") {
      throw invalidArgument("metadata.requestId is required");
    }
    if (!Number.isInteger(metadata.timeoutMs) || metadata.timeoutMs <= 0) {
      throw invalidArgument("metadata.timeoutMs must be a positive integer");
    }
    if (metadata.prefix.trim() === "") {
      throw invalidArgument("metadata.prefix is required");
    }
    if (metadata.prefix !== prefix || metadata.prefix !== this.prefix) {
      throw invalidArgument(`request prefix "${metadata.prefix}" does not match server prefix "${this.prefix}"`);
    }
  }

  private validateEmbedding(embedding: Embedding): void {
    if (!embedding || !Array.isArray(embedding.vector) || embedding.vector.length === 0) {
      throw invalidArgument("embedding.vector must be a non-empty array");
    }
    if (embedding.vector.some((value) => !Number.isFinite(value))) {
      throw invalidArgument("embedding.vector must contain only finite numbers");
    }
    if (!Number.isInteger(embedding.dimensions) || embedding.dimensions <= 0) {
      throw invalidArgument("embedding.dimensions must be a positive integer");
    }
    if (embedding.vector.length !== embedding.dimensions) {
      throw invalidArgument("embedding.vector length must equal embedding.dimensions");
    }
  }

  private requireNonEmpty(value: string, field: string): void {
    if (value.trim() === "") {
      throw invalidArgument(`${field} is required`);
    }
  }

  private async runGraphRequest<T>(
    endpoint: string,
    metadata: RequestMetadata,
    priority: RequestPriority,
    execute: () => Promise<T>,
  ): Promise<T> {
    return this.runRequest(`Graph.${endpoint}`, metadata, priority, execute);
  }

  private async runVectorRequest<T>(
    endpoint: string,
    metadata: RequestMetadata,
    priority: RequestPriority,
    execute: () => Promise<T>,
  ): Promise<T> {
    return this.runRequest(`Vector.${endpoint}`, metadata, priority, execute);
  }

  private async runRequest<T>(
    endpoint: string,
    metadata: RequestMetadata,
    priority: RequestPriority,
    execute: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await this.scheduler.enqueue({
        id: metadata.requestId,
        priority,
        timeoutMs: metadata.timeoutMs,
        execute,
      });
      this.metrics.recordRequest(endpoint, Date.now() - startedAt, "ok");
      return result;
    } catch (error) {
      logServerEvent("error", "request_failed", {
        endpoint,
        error,
        requestId: metadata.requestId,
      });
      this.metrics.recordRequest(
        endpoint,
        Date.now() - startedAt,
        isTimeoutError(error) ? "timeout" : "error",
      );
      throw error;
    }
  }
}

function invalidArgument(message: string): Error & { readonly code: number } {
  const error = new Error(message) as Error & { readonly code: number };
  error.name = "InvalidArgumentError";
  Object.assign(error, { code: status.INVALID_ARGUMENT });
  return error;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "RequestTimeoutError";
}
