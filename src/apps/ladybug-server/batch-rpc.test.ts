import { describe, expect, it, vi } from "vitest";

vi.mock("@grpc/grpc-js", () => ({
  status: {
    INVALID_ARGUMENT: 3,
    DEADLINE_EXCEEDED: 4,
    RESOURCE_EXHAUSTED: 8,
    INTERNAL: 13,
    UNAVAILABLE: 14,
  },
}));

import type { Embedding } from "../../core/domain.js";
import { createGraphService } from "./services/graph.js";
import { createVectorService } from "./services/vector.js";
import type { GraphOperation, OperationRouter, VectorOperation } from "./router.js";

function invokeUnary(
  handler: (call: unknown, callback: (error: unknown, response?: unknown) => void) => void | Promise<void>,
  request: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    Promise.resolve(
      handler({ request }, (error, response) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      }),
    ).catch(reject);
  });
}

const metadata = { requestId: "req-1", timeoutMs: 1000, prefix: "tpc_" };

describe("Batch RPC service handlers", () => {
  it("CreateNodes parses nodesJson into a CreateNodes operation and routes it", async () => {
    let routed: GraphOperation | undefined;
    const service = createGraphService({
      routeGraphOp: vi.fn(async (op: GraphOperation) => {
        routed = op;
      }),
      routeVectorOp: vi.fn(),
      getMetrics: vi.fn(),
      getSchedulerStats: vi.fn(),
    } as unknown as OperationRouter);

    const nodes = [{ id: "s1", kind: "function" }, { id: "s2", kind: "class" }];
    const response = await invokeUnary(service.CreateNodes, {
      metadata,
      label: "Symbol",
      nodesJson: JSON.stringify(nodes),
    });

    expect(response).toEqual({ success: true });
    expect(routed).toMatchObject({
      kind: "CreateNodes",
      label: "Symbol",
      nodes,
      priority: "background_write",
    });
  });

  it("CreateRelationships parses relationshipsJson and routes it", async () => {
    let routed: GraphOperation | undefined;
    const service = createGraphService({
      routeGraphOp: vi.fn(async (op: GraphOperation) => {
        routed = op;
      }),
      routeVectorOp: vi.fn(),
      getMetrics: vi.fn(),
      getSchedulerStats: vi.fn(),
    } as unknown as OperationRouter);

    const relationships = [
      { fromId: "a", toId: "b", properties: { step_order: 1 } },
      { fromId: "c", toId: "d" },
    ];
    const response = await invokeUnary(service.CreateRelationships, {
      metadata,
      type: "HAS_STEP",
      relationshipsJson: JSON.stringify(relationships),
    });

    expect(response).toEqual({ success: true });
    expect(routed).toMatchObject({
      kind: "CreateRelationships",
      type: "HAS_STEP",
      relationships,
      priority: "background_write",
    });
  });

  it("CreateNodes rejects malformed JSON with INVALID_ARGUMENT", async () => {
    const service = createGraphService({
      routeGraphOp: vi.fn(),
      routeVectorOp: vi.fn(),
      getMetrics: vi.fn(),
      getSchedulerStats: vi.fn(),
    } as unknown as OperationRouter);

    await expect(
      invokeUnary(service.CreateNodes, { metadata, label: "Symbol", nodesJson: "{not json" }),
    ).rejects.toMatchObject({ code: 3 });
  });

  it("CreateRelationships rejects a non-array payload with INVALID_ARGUMENT", async () => {
    const service = createGraphService({
      routeGraphOp: vi.fn(),
      routeVectorOp: vi.fn(),
      getMetrics: vi.fn(),
      getSchedulerStats: vi.fn(),
    } as unknown as OperationRouter);

    await expect(
      invokeUnary(service.CreateRelationships, {
        metadata,
        type: "CALLS",
        relationshipsJson: JSON.stringify({ not: "an array" }),
      }),
    ).rejects.toMatchObject({ code: 3 });
  });

  it("IndexSymbols parses entriesJson (embedding + metadata round-trip) and routes it", async () => {
    let routed: VectorOperation | undefined;
    const service = createVectorService({
      routeGraphOp: vi.fn(),
      routeVectorOp: vi.fn(async (op: VectorOperation) => {
        routed = op;
      }),
      getMetrics: vi.fn(),
      getSchedulerStats: vi.fn(),
    } as unknown as OperationRouter);

    const embedding: Embedding = { vector: [0.1, 0.2], dimensions: 2 };
    const entries = [
      { symbolId: "sym-1", embedding, metadata: { kind: "function" } },
      { symbolId: "sym-2", embedding: { vector: [0.3, 0.4], dimensions: 2 } },
    ];
    const response = await invokeUnary(service.IndexSymbols, {
      metadata,
      entriesJson: JSON.stringify(entries),
    });

    expect(response).toEqual({ success: true });
    expect(routed?.kind).toBe("IndexSymbols");
    const indexOp = routed as Extract<VectorOperation, { kind: "IndexSymbols" }>;
    expect(indexOp.entries[0]).toEqual({
      symbolId: "sym-1",
      embedding: { vector: [0.1, 0.2], dimensions: 2 },
      metadata: { kind: "function" },
    });
    expect(indexOp.entries[1].embedding).toEqual({ vector: [0.3, 0.4], dimensions: 2 });
  });

  it("IndexSymbols rejects malformed JSON with INVALID_ARGUMENT", async () => {
    const service = createVectorService({
      routeGraphOp: vi.fn(),
      routeVectorOp: vi.fn(),
      getMetrics: vi.fn(),
      getSchedulerStats: vi.fn(),
    } as unknown as OperationRouter);

    await expect(
      invokeUnary(service.IndexSymbols, { metadata, entriesJson: "[broken" }),
    ).rejects.toMatchObject({ code: 3 });
  });
});

describe("Batch RPC router dispatch", () => {
  function makeRouter(graphAdapter: Record<string, unknown>, vectorAdapter: Record<string, unknown>) {
    const scheduler = {
      enqueue: async <T,>(req: { readonly execute: () => Promise<T> }) => req.execute(),
      stats: () => ({
        inFlight: 0,
        queued: 0,
        totalProcessed: 0,
        totalTimedOut: 0,
        totalRejected: 0,
        acceptingRequests: true,
      }),
    };
    const runtime = {
      getConnection: () => ({}),
      getDatabase: () => ({}),
      open: vi.fn(),
      close: vi.fn(),
      isHealthy: () => true,
    };
    // Lazily import to avoid constructing real Ladybug adapters with a fake conn.
    return { scheduler, runtime, graphAdapter, vectorAdapter };
  }

  it("routeGraphOp dispatches CreateNodes/CreateRelationships to adapter batch methods", async () => {
    const { DefaultOperationRouter } = await import("./router.js");
    const createNodes = vi.fn(async () => undefined);
    const createRelationships = vi.fn(async () => undefined);
    const { scheduler, runtime } = makeRouter({}, {});
    const router = new DefaultOperationRouter(runtime as never, scheduler as never, "tpc_");
    // Replace the embedded adapter with a stub.
    (router as unknown as { graphAdapter: unknown }).graphAdapter = {
      createNodes,
      createRelationships,
    };

    await router.routeGraphOp(
      {
        kind: "CreateNodes",
        metadata,
        label: "Symbol",
        nodes: [{ id: "s1" }],
        priority: "background_write",
      },
      "tpc_",
    );
    expect(createNodes).toHaveBeenCalledWith("Symbol", [{ id: "s1" }]);

    await router.routeGraphOp(
      {
        kind: "CreateRelationships",
        metadata,
        type: "CALLS",
        relationships: [{ fromId: "a", toId: "b" }],
        priority: "background_write",
      },
      "tpc_",
    );
    expect(createRelationships).toHaveBeenCalledWith("CALLS", [{ fromId: "a", toId: "b" }]);
  });

  it("routeVectorOp dispatches IndexSymbols to the adapter batch method", async () => {
    const { DefaultOperationRouter } = await import("./router.js");
    const indexSymbols = vi.fn(async () => undefined);
    const { scheduler, runtime } = makeRouter({}, {});
    const router = new DefaultOperationRouter(runtime as never, scheduler as never, "tpc_");
    (router as unknown as { vectorAdapter: unknown }).vectorAdapter = { indexSymbols };

    const entries = [
      { symbolId: "sym-1", embedding: { vector: [0.1, 0.2], dimensions: 2 }, metadata: { k: "v" } },
    ];
    await router.routeVectorOp(
      { kind: "IndexSymbols", metadata, entries, priority: "background_write" },
      "tpc_",
    );
    expect(indexSymbols).toHaveBeenCalledWith(entries);
  });
});
