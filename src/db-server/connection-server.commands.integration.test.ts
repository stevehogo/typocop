import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@grpc/proto-loader", async () => {
  const { createProtoLoaderMock } = await import("./grpc-test-mocks.js");
  return createProtoLoaderMock();
});

vi.mock("@grpc/grpc-js", async () => {
  const { createGrpcJsMock } = await import("./grpc-test-mocks.js");
  return createGrpcJsMock();
});

import { startConnectionServer } from "./server.js";
import { invokeUnary, makeServerConfig } from "./connection-server.test-support.js";

function makeRequestMetadata(prefix: string) {
  return {
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    timeoutMs: 5_000,
    prefix,
  };
}

describe("Ladybug connection server command surface — integration test", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    const grpcModule = await import("@grpc/grpc-js") as {
      readonly __clearServers: () => void;
    };
    grpcModule.__clearServers();
  });

  it("exercises every exposed connection-server RPC successfully", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-ladybug-commands-"));
    const serverConfig = makeServerConfig(root, { port: 7624 });
    const server = await startConnectionServer(serverConfig);

    try {
      const grpcModule = await import("@grpc/grpc-js") as {
        readonly __getServer: (address: string) => {
          readonly implementations: Map<string, Record<string, (...args: any[]) => any>>;
        } | undefined;
      };
      const boundServer = grpcModule.__getServer(`${serverConfig.host}:${serverConfig.port}`);
      const health = boundServer?.implementations.get("Health");
      const admin = boundServer?.implementations.get("Admin");
      const graph = boundServer?.implementations.get("Graph");
      const vector = boundServer?.implementations.get("Vector");

      expect(health).toBeDefined();
      expect(admin).toBeDefined();
      expect(graph).toBeDefined();
      expect(vector).toBeDefined();

      const metadata = makeRequestMetadata(serverConfig.prefix);

      await expect(invokeUnary(health!.Check, {})).resolves.toMatchObject({
        status: 1,
        message: "SERVING",
      });

      await expect(invokeUnary(admin!.GetMetrics, {})).resolves.toMatchObject({
        metrics: expect.objectContaining({
          dbOpen: true,
          inFlightRequests: 0,
        }),
        scheduler: expect.objectContaining({
          acceptingRequests: true,
        }),
      });

      await expect(
        invokeUnary(graph!.CreateNode, {
          metadata,
          label: "Symbol",
          propertiesJson: JSON.stringify({
            id: "symbol-alpha",
            name: "alpha",
            kind: "function",
          }),
        }),
      ).resolves.toEqual({ success: true });

      await expect(
        invokeUnary(graph!.CreateNode, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          label: "Symbol",
          propertiesJson: JSON.stringify({
            id: "symbol-beta",
            name: "beta",
            kind: "function",
          }),
        }),
      ).resolves.toEqual({ success: true });

      await expect(
        invokeUnary(graph!.CreateRelationship, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          fromId: "symbol-alpha",
          toId: "symbol-beta",
          type: "CALLS",
          propertiesJson: JSON.stringify({}),
        }),
      ).resolves.toEqual({ success: true });

      await expect(
        invokeUnary(graph!.QueryNodes, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          label: "Symbol",
          filterJson: JSON.stringify({ id: "symbol-alpha" }),
        }),
      ).resolves.toMatchObject({
        nodes: [
          expect.objectContaining({
            id: "symbol-alpha",
          }),
        ],
      });

      await expect(
        invokeUnary(graph!.QueryRelationships, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          type: "CALLS",
        }),
      ).resolves.toMatchObject({
        relationships: [
          expect.objectContaining({
            type: `${serverConfig.prefix}CALLS`,
            sourceId: "symbol-alpha",
            targetId: "symbol-beta",
          }),
        ],
      });

      await expect(
        invokeUnary(graph!.RunCypherWrite, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          query: 'MERGE (n:Symbol {id: "symbol-gamma"}) SET n.name = "gamma", n.kind = "function"',
          paramsJson: JSON.stringify({}),
        }),
      ).resolves.toEqual({ success: true });

      await expect(
        invokeUnary(graph!.RunCypher, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          query: 'MATCH (n:Symbol {id: "symbol-gamma"}) RETURN n',
          paramsJson: JSON.stringify({}),
        }),
      ).resolves.toMatchObject({
        rowsJson: [
          expect.any(String),
        ],
      });

      await expect(
        invokeUnary(vector!.CreateTables, {
          metadata: makeRequestMetadata(serverConfig.prefix),
        }),
      ).resolves.toEqual({ success: true });

      await expect(
        invokeUnary(vector!.IndexSymbol, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          symbolId: "symbol-alpha",
          embedding: { vector: [1, 0], dimensions: 2 },
          metadataJson: JSON.stringify({ kind: "function" }),
        }),
      ).resolves.toEqual({ success: true });

      await expect(
        invokeUnary(vector!.IndexSymbol, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          symbolId: "symbol-beta",
          embedding: { vector: [0.9, 0.1], dimensions: 2 },
          metadataJson: JSON.stringify({ kind: "function" }),
        }),
      ).resolves.toEqual({ success: true });

      const semanticSearch = await invokeUnary(vector!.SemanticSearch, {
        metadata: makeRequestMetadata(serverConfig.prefix),
        embedding: { vector: [1, 0], dimensions: 2 },
        limit: 5,
      }) as {
        readonly results: Array<{
          readonly symbolId: string;
          readonly score: number;
          readonly metadataJson: string;
        }>;
      };
      expect(semanticSearch.results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbolId: "symbol-alpha",
        }),
      ]));
      expect(semanticSearch.results[0]?.symbolId).toBe("symbol-alpha");

      await expect(
        invokeUnary(vector!.DeleteAll, {
          metadata: makeRequestMetadata(serverConfig.prefix),
        }),
      ).resolves.toEqual({ deletedCount: 2 });

      await expect(
        invokeUnary(graph!.DeleteRelationshipsByType, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          type: "CALLS",
        }),
      ).resolves.toEqual({ deletedCount: 0 });

      await expect(
        invokeUnary(graph!.DeleteNodesByLabel, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          label: "Symbol",
        }),
      ).resolves.toEqual({ deletedCount: 0 });

      await expect(
        invokeUnary(graph!.QueryNodes, {
          metadata: makeRequestMetadata(serverConfig.prefix),
          label: "Symbol",
          filterJson: JSON.stringify({}),
        }),
      ).resolves.toEqual({ nodes: [] });

      await expect(
        invokeUnary(admin!.Shutdown, {
          force: false,
        }),
      ).resolves.toEqual({ accepted: true });

      await server.waitForShutdown();
      await expect(access(serverConfig.discoveryPath)).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
