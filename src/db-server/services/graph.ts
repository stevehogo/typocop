import { status } from "@grpc/grpc-js";
import type { GraphNode, GraphRelationship } from "../../core/ports/persistence.js";
import { toServiceError } from "../errors.js";
import type { GraphOperation, OperationRouter } from "../router.js";
import type { RequestMetadata } from "../types.js";

export function createGraphService(router: OperationRouter): Record<string, (call: any, callback: (error: unknown, response?: unknown) => void) => Promise<void>> {
  return {
    async QueryNodes(call, callback) {
      await handle(router, callback, {
        kind: "QueryNodes",
        metadata: parseMetadata(call.request.metadata),
        label: call.request.label || "",
        filter: parseJsonRecord(call.request.filterJson),
        priority: "interactive_read",
      }, (result) => ({ nodes: serializeNodes(result as GraphNode[]) }));
    },

    async QueryRelationships(call, callback) {
      await handle(router, callback, {
        kind: "QueryRelationships",
        metadata: parseMetadata(call.request.metadata),
        type: call.request.type || "",
        priority: "interactive_read",
      }, (result) => ({ relationships: serializeRelationships(result as GraphRelationship[]) }));
    },

    async RunCypher(call, callback) {
      await handle(router, callback, {
        kind: "RunCypher",
        metadata: parseMetadata(call.request.metadata),
        query: call.request.query || "",
        params: parseJsonRecord(call.request.paramsJson),
        priority: "interactive_read",
      }, (result) => ({ rowsJson: (result as Record<string, unknown>[]).map((row) => JSON.stringify(row)) }));
    },

    async RunCypherWrite(call, callback) {
      await handle(router, callback, {
        kind: "RunCypherWrite",
        metadata: parseMetadata(call.request.metadata),
        query: call.request.query || "",
        params: parseJsonRecord(call.request.paramsJson),
        priority: "background_write",
      }, () => ({ success: true }));
    },

    async CreateNode(call, callback) {
      await handle(router, callback, {
        kind: "CreateNode",
        metadata: parseMetadata(call.request.metadata),
        label: call.request.label || "",
        properties: parseJsonRecord(call.request.propertiesJson),
        priority: "background_write",
      }, () => ({ success: true }));
    },

    async CreateRelationship(call, callback) {
      await handle(router, callback, {
        kind: "CreateRelationship",
        metadata: parseMetadata(call.request.metadata),
        fromId: call.request.fromId || "",
        toId: call.request.toId || "",
        type: call.request.type || "",
        properties: parseJsonRecord(call.request.propertiesJson),
        priority: "background_write",
      }, () => ({ success: true }));
    },

    async DeleteNodesByLabel(call, callback) {
      await handle(router, callback, {
        kind: "DeleteNodesByLabel",
        metadata: parseMetadata(call.request.metadata),
        label: call.request.label || "",
        priority: "background_write",
      }, (result) => ({ deletedCount: result as number }));
    },

    async DeleteRelationshipsByType(call, callback) {
      await handle(router, callback, {
        kind: "DeleteRelationshipsByType",
        metadata: parseMetadata(call.request.metadata),
        type: call.request.type || "",
        priority: "background_write",
      }, (result) => ({ deletedCount: result as number }));
    },
  };
}

async function handle(
  router: OperationRouter,
  callback: (error: unknown, response?: unknown) => void,
  operation: GraphOperation,
  format: (result: unknown) => unknown,
): Promise<void> {
  try {
    const result = await router.routeGraphOp(operation, operation.metadata.prefix);
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

function parseJsonRecord(input: string | undefined): Record<string, unknown> {
  if (!input) {
    return {};
  }
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw invalidJson("JSON payload must decode to an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw error instanceof Error ? error : invalidJson();
  }
}

function serializeNodes(nodes: readonly GraphNode[]): Array<Record<string, unknown>> {
  return nodes.map((node) => ({
    id: node.id,
    labels: [...node.labels],
    propertiesJson: JSON.stringify(node.properties),
  }));
}

function serializeRelationships(relationships: readonly GraphRelationship[]): Array<Record<string, unknown>> {
  return relationships.map((relationship) => ({
    type: relationship.type,
    propertiesJson: JSON.stringify(relationship.properties),
    sourceId: relationship.sourceId || "",
    targetId: relationship.targetId || "",
  }));
}

function invalidJson(message = "JSON payload is invalid"): Error & { readonly code: number } {
  const error = new Error(message) as Error & { readonly code: number };
  error.name = "InvalidJsonError";
  Object.assign(error, { code: status.INVALID_ARGUMENT });
  return error;
}
