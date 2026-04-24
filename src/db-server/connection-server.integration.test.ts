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

import { RemoteDatabaseAdapter } from "../db/remote-database-adapter.js";
import { LadybugGraphAdapter } from "../db/ladybug-graph-adapter.js";
import { startConnectionServer } from "./server.js";
import { LadybugEmbeddedDatabaseRuntime } from "./runtime.js";
import {
  flushMicrotasks,
  invokeUnary,
  linkSymbols,
  makeClientConfig,
  makeServerConfig,
  sortNodes,
  writeSymbol,
} from "./connection-server.test-support.js";

describe("Ladybug connection server — integration tests", () => {
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

  it("14.1 single server with concurrent clients proxies graph and vector operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-ladybug-int-"));
    const serverConfig = makeServerConfig(root, { port: 7619 });
    const server = await startConnectionServer(serverConfig);
    const clients = Array.from({ length: 3 }, () => new RemoteDatabaseAdapter(makeClientConfig(serverConfig)));

    try {
      await Promise.all(clients.map((client) => client.initialize()));

      await Promise.all(
        clients.map((client, index) =>
          writeSymbol(client, `symbol-${index + 1}`),
        ),
      );
      await linkSymbols(clients[0], "symbol-1", "symbol-2");

      const allNodes = await Promise.all(
        clients.map((client) => client.getGraphAdapter().queryNodes("Symbol")),
      );
      for (const nodes of allNodes) {
        expect(sortNodes(nodes).map((node) => node.id)).toEqual([
          "symbol-1",
          "symbol-2",
          "symbol-3",
        ]);
      }

      await Promise.all(
        clients.map((client, index) =>
          client.getVectorAdapter().indexSymbol(
            `symbol-${index + 1}`,
            { vector: [1 - index * 0.1, index * 0.1], dimensions: 2 },
            { kind: "function" },
          ),
        ),
      );
      await expect(clients[1].getVectorAdapter().deleteAll()).resolves.toBe(3);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await server.shutdown("test");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("14.2 graceful shutdown drains in-flight requests, closes the runtime, and removes discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-ladybug-shutdown-"));
    const gate = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((nextResolve) => {
        resolve = nextResolve;
      });
      return { promise, resolve };
    })();

    const originalQueryNodes = LadybugGraphAdapter.prototype.queryNodes;
    vi.spyOn(LadybugGraphAdapter.prototype, "queryNodes").mockImplementation(async function (
      ...args
    ) {
      await gate.promise;
      return originalQueryNodes.apply(this, args);
    });
    const closeSpy = vi.spyOn(LadybugEmbeddedDatabaseRuntime.prototype, "close");

    const serverConfig = makeServerConfig(root, { port: 7620 });
    const server = await startConnectionServer(serverConfig);
    const client = new RemoteDatabaseAdapter(makeClientConfig(serverConfig));

    try {
      await client.initialize();
      await writeSymbol(client, "symbol-1");

      const pendingQuery = client.getGraphAdapter().queryNodes("Symbol");
      await flushMicrotasks();

      const shutdownPromise = server.shutdown("SIGTERM");
      gate.resolve();

      await expect(pendingQuery).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "symbol-1" }),
        ]),
      );
      await shutdownPromise;

      await expect(access(serverConfig.discoveryPath)).rejects.toBeDefined();
      expect(closeSpy).toHaveBeenCalledOnce();
      await expect(client.getGraphAdapter().queryNodes("Symbol")).rejects.toMatchObject({
        code: 14,
      });
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });

});
