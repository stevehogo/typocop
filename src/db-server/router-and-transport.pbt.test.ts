import { describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

vi.mock("@grpc/grpc-js", () => ({
  status: {
    INVALID_ARGUMENT: 3,
    DEADLINE_EXCEEDED: 4,
    RESOURCE_EXHAUSTED: 8,
    INTERNAL: 13,
    UNAVAILABLE: 14,
  },
}));

import { RemoteGraphAdapter } from "../db/remote-graph-adapter.js";
import { RemoteVectorAdapter } from "../db/remote-vector-adapter.js";
import type { GraphNode, GraphRelationship } from "../db/types.js";
import { createGraphService } from "./services/graph.js";
import { createVectorService } from "./services/vector.js";
import { DefaultOperationRouter } from "./router.js";

const validPrefixArb = fc
  .array(fc.constantFrom(...("abcdefghijklmnopqrstuvwxyz0123456789" as const)), {
    minLength: 1,
    maxLength: 8,
  })
  .map((chars) => `${chars.join("")}_`);

const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 5 }), tie("value"), { maxKeys: 4 }),
  ),
})).value;

const graphNodeArb: fc.Arbitrary<GraphNode> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }),
  labels: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 3 }),
  properties: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), jsonValueArb, {
    maxKeys: 5,
  }),
});

const searchResultArb = fc.record({
  symbolId: fc.string({ minLength: 1, maxLength: 12 }),
  score: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  metadata: fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.string(), {
    maxKeys: 5,
  }),
});

function invokeUnary(
  handler: (call: unknown, callback: (error: unknown, response?: unknown) => void) => void | Promise<void>,
  request: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    void handler({ request }, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

describe("Connection-server router and transport — property tests", () => {
  it("Property 8: OperationRouter enforces prefix isolation and remote requests include the configured prefix", async () => {
    await fc.assert(
      fc.asyncProperty(validPrefixArb, validPrefixArb, async (serverPrefix, requestPrefix) => {
        const queries: string[] = [];
        const fakeConnection = {
          query: vi.fn(async (query: string) => {
            queries.push(query);
            return {
              getAll: async () => [
                {
                  n: {
                    id: "node-1",
                    _label: `${serverPrefix}Symbol`,
                    name: "main",
                  },
                },
              ],
            };
          }),
        };
        const runtime = {
          getConnection: () => fakeConnection,
          getDatabase: () => ({}) as never,
          open: vi.fn(),
          close: vi.fn(),
          isHealthy: () => true,
        };
        const scheduler = {
          enqueue: async <T,>(request: { readonly execute: () => Promise<T> }) => request.execute(),
          stats: () => ({
            inFlight: 0,
            queued: 0,
            totalProcessed: 0,
            totalTimedOut: 0,
            totalRejected: 0,
            acceptingRequests: true,
          }),
        };

        const router = new DefaultOperationRouter(runtime as never, scheduler, serverPrefix);

        const operation = {
          kind: "QueryNodes" as const,
          metadata: {
            requestId: "req-1",
            timeoutMs: 1_000,
            prefix: requestPrefix,
          },
          label: "Symbol",
          filter: {},
          priority: "interactive_read" as const,
        };

        if (serverPrefix === requestPrefix) {
          const nodes = await router.routeGraphOp(operation, requestPrefix);
          expect(nodes).toEqual([
            {
              id: "node-1",
              labels: [`${serverPrefix}Symbol`],
              properties: {
                id: "node-1",
                _label: `${serverPrefix}Symbol`,
                name: "main",
              },
            },
          ]);
          expect(queries[0]).toContain(`${serverPrefix}Symbol`);
        } else {
          await expect(router.routeGraphOp(operation, requestPrefix)).rejects.toMatchObject({
            code: 3,
          });
        }

        let capturedPrefix = "";
        const adapter = new RemoteGraphAdapter({
          buildRequestMetadata: () => ({
            requestId: "req-1",
            timeoutMs: 123,
            prefix: requestPrefix,
          }),
          callGraph: vi.fn(async (_method, request) => {
            capturedPrefix = request.metadata.prefix;
            return { nodes: [] };
          }) as never,
          callVector: vi.fn() as never,
        });
        await adapter.queryNodes("Symbol");
        expect(capturedPrefix).toBe(requestPrefix);
      }),
      { numRuns: 30 },
    );
  });

  it("Property 10: GraphNode protobuf serialization round-trips through graph service and remote adapter", async () => {
    await fc.assert(
      fc.asyncProperty(graphNodeArb, async (node) => {
        const service = createGraphService({
          routeGraphOp: vi.fn(async () => [node] as GraphNode[]),
          routeVectorOp: vi.fn(),
          getMetrics: vi.fn(),
          getSchedulerStats: vi.fn(),
        } as never);

        const adapter = new RemoteGraphAdapter({
          buildRequestMetadata: () => ({
            requestId: "req-1",
            timeoutMs: 1_000,
            prefix: "tpc_",
          }),
          callGraph: vi.fn(async (_method, request) =>
            invokeUnary(service.QueryNodes, request),
          ) as never,
          callVector: vi.fn() as never,
        });

        await expect(adapter.queryNodes("Symbol")).resolves.toEqual([node]);
      }),
      { numRuns: 35 },
    );
  });

  it("Property 11: SearchResult protobuf serialization round-trips through vector service and remote adapter", async () => {
    await fc.assert(
      fc.asyncProperty(searchResultArb, async (result) => {
        const service = createVectorService({
          routeGraphOp: vi.fn(),
          routeVectorOp: vi.fn(async () => [result]),
          getMetrics: vi.fn(),
          getSchedulerStats: vi.fn(),
        } as never);

        const adapter = new RemoteVectorAdapter({
          buildRequestMetadata: () => ({
            requestId: "req-1",
            timeoutMs: 1_000,
            prefix: "tpc_",
          }),
          callGraph: vi.fn() as never,
          callVector: vi.fn(async (_method, request) =>
            invokeUnary(service.SemanticSearch, request),
          ) as never,
        });

        await expect(
          adapter.semanticSearch({ vector: [1, 0], dimensions: 2 }, 5),
        ).resolves.toEqual([result]);
      }),
      { numRuns: 35 },
    );
  });
});
