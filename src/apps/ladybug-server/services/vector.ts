import { status } from "@grpc/grpc-js";
import type { Embedding, SearchResult } from "../../../core/domain.js";
import { toServiceError } from "../../../infrastructure/remote-transport/errors.js";
import type { OperationRouter, VectorOperation } from "../router.js";
import type { RequestMetadata } from "../types.js";

export function createVectorService(router: OperationRouter): Record<string, (call: any, callback: (error: unknown, response?: unknown) => void) => Promise<void>> {
  return {
    async CreateTables(call, callback) {
      await handle(router, callback, {
        kind: "CreateTables",
        metadata: parseMetadata(call.request.metadata),
        priority: "background_write",
      }, () => ({ success: true }));
    },

    async IndexSymbol(call, callback) {
      await handle(router, callback, {
        kind: "IndexSymbol",
        metadata: parseMetadata(call.request.metadata),
        symbolId: call.request.symbolId || "",
        embedding: {
          vector: Array.isArray(call.request.embedding?.vector) ? call.request.embedding.vector.map(Number) : [],
          dimensions: Number(call.request.embedding?.dimensions || 0),
        },
        metadataMap: parseStringRecord(call.request.metadataJson),
        priority: "background_write",
      }, () => ({ success: true }));
    },

    async IndexSymbols(call, callback) {
      await handle(router, callback, {
        kind: "IndexSymbols",
        metadata: parseMetadata(call.request.metadata),
        entries: parseEntries(call.request.entriesJson),
        priority: "background_write",
      }, () => ({ success: true }));
    },

    async SemanticSearch(call, callback) {
      await handle(router, callback, {
        kind: "SemanticSearch",
        metadata: parseMetadata(call.request.metadata),
        queryEmbedding: {
          vector: Array.isArray(call.request.embedding?.vector) ? call.request.embedding.vector.map(Number) : [],
          dimensions: Number(call.request.embedding?.dimensions || 0),
        },
        limit: Number(call.request.limit || 0),
        priority: "interactive_read",
      }, (result) => ({ results: serializeResults(result as SearchResult[]) }));
    },

    async DeleteAll(call, callback) {
      await handle(router, callback, {
        kind: "DeleteAll",
        metadata: parseMetadata(call.request.metadata),
        priority: "background_write",
      }, (result) => ({ deletedCount: result as number }));
    },
  };
}

async function handle(
  router: OperationRouter,
  callback: (error: unknown, response?: unknown) => void,
  operation: VectorOperation,
  format: (result: unknown) => unknown,
): Promise<void> {
  try {
    const result = await router.routeVectorOp(operation, operation.metadata.prefix);
    callback(null, format(result));
  } catch (error) {
    callback(toServiceError(error));
  }
}

function parseMetadata(input: Partial<RequestMetadata> | undefined): RequestMetadata {
  return {
    requestId: input?.requestId || "",
    timeoutMs: Number(input?.timeoutMs || 0),
    prefix: input?.prefix || "",
  };
}

function parseStringRecord(input: string | undefined): Record<string, string> {
  if (!input) {
    return {};
  }
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw invalidJson("JSON payload must decode to an object");
    }

    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.some(([, value]) => typeof value !== "string")) {
      throw invalidJson("metadataJson values must all be strings");
    }

    return Object.fromEntries(entries) as Record<string, string>;
  } catch (error) {
    throw error instanceof Error ? error : invalidJson();
  }
}

function parseJsonArray(input: string | undefined): unknown[] {
  if (!input) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw invalidJson("JSON payload is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw invalidJson("JSON payload must decode to an array");
  }
  return parsed;
}

function parseEntries(input: string | undefined): Array<{
  symbolId: string;
  embedding: Embedding;
  metadata?: Record<string, string>;
}> {
  return parseJsonArray(input).map((raw) => {
    const entry = raw as {
      symbolId?: string;
      embedding?: { vector?: unknown; dimensions?: unknown };
      metadata?: Record<string, string>;
    };
    return {
      symbolId: entry.symbolId || "",
      embedding: {
        vector: Array.isArray(entry.embedding?.vector)
          ? entry.embedding!.vector.map(Number)
          : [],
        dimensions: Number(entry.embedding?.dimensions || 0),
      },
      metadata: entry.metadata,
    };
  });
}

function serializeResults(results: readonly SearchResult[]): Array<Record<string, unknown>> {
  return results.map((result) => ({
    symbolId: result.symbolId,
    score: result.score,
    metadataJson: JSON.stringify(result.metadata),
  }));
}

function invalidJson(message = "JSON payload is invalid"): Error & { readonly code: number } {
  const error = new Error(message) as Error & { readonly code: number };
  error.name = "InvalidJsonError";
  Object.assign(error, { code: status.INVALID_ARGUMENT });
  return error;
}
