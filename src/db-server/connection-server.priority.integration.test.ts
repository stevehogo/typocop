import { mkdtemp, rm } from "node:fs/promises";
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
import {
  flushMicrotasks,
  invokeUnary,
  makeClientConfig,
  makeServerConfig,
  writeSymbol,
} from "./connection-server.test-support.js";

describe("Ladybug connection server priority scheduling — integration test", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    const grpcModule = await import("@grpc/grpc-js") as unknown as {
      readonly __clearServers: () => void;
    };
    grpcModule.__clearServers();
  });

  it("14.3 priority scheduling under load keeps admin responsive and favors reads over queued writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "typocop-ladybug-priority-"));
    const gate = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((nextResolve) => {
        resolve = nextResolve;
      });
      return { promise, resolve };
    })();

    const order: string[] = [];
    const originalRunCypherWrite = LadybugGraphAdapter.prototype.runCypherWrite;
    vi.spyOn(LadybugGraphAdapter.prototype, "runCypherWrite").mockImplementation(async function (
      this: LadybugGraphAdapter,
      query,
      params,
    ) {
      const marker = query.includes("blocked")
        ? "blocked"
        : query.includes("queued-write")
          ? "queued-write"
          : "other";
      order.push(`write:${marker}`);
      if (marker === "blocked") {
        await gate.promise;
      }
      return originalRunCypherWrite.call(this, query, params);
    });
    const originalQueryNodes = LadybugGraphAdapter.prototype.queryNodes;
    vi.spyOn(LadybugGraphAdapter.prototype, "queryNodes").mockImplementation(async function (
      this: LadybugGraphAdapter,
      ...args
    ) {
      order.push("query");
      return originalQueryNodes.apply(this, args);
    });

    const serverConfig = makeServerConfig(root, { port: 7621, maxConcurrency: 1 });
    const server = await startConnectionServer(serverConfig);
    const client = new RemoteDatabaseAdapter(makeClientConfig(serverConfig));

    try {
      await client.initialize();

      const blockedWrite = writeSymbol(client, "blocked");
      await flushMicrotasks();

      const queuedWrite = writeSymbol(client, "queued-write");
      const queuedRead = client.getGraphAdapter().queryNodes("Symbol");

      const grpcModule = await import("@grpc/grpc-js") as unknown as {
        readonly __getServer: (address: string) => {
          readonly implementations: Map<string, Record<string, (...args: any[]) => any>>;
        } | undefined;
      };
      const boundServer = grpcModule.__getServer(`${serverConfig.host}:${serverConfig.port}`);
      const adminService = boundServer?.implementations.get("Admin");
      const metrics = await invokeUnary(adminService!.GetMetrics, {});

      expect(metrics).toMatchObject({
        scheduler: expect.objectContaining({
          inFlight: 1,
          queued: 2,
        }),
      });

      gate.resolve();
      await Promise.all([blockedWrite, queuedWrite, queuedRead]);

      expect(order.indexOf("query")).toBeGreaterThan(-1);
      expect(order.indexOf("write:queued-write")).toBeGreaterThan(-1);
      expect(order.indexOf("query")).toBeLessThan(order.indexOf("write:queued-write"));
    } finally {
      await client.close();
      await server.shutdown("test");
      await rm(root, { recursive: true, force: true });
    }
  });
});
