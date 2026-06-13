import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@grpc/proto-loader", () => ({
  loadSync: vi.fn(() => ({
    typocop: {
      ladybug: {
        v1: {
          Health: { service: { serviceName: "Health" } },
          Admin: { service: { serviceName: "Admin" } },
          Graph: { service: { serviceName: "Graph" } },
          Vector: { service: { serviceName: "Vector" } },
        },
      },
    },
  })),
}));

vi.mock("@grpc/grpc-js", () => {
  const servers = new Map<string, FakeServer>();
  let lastServerOptions: unknown;

  class FakeServer {
    readonly implementations = new Map<string, Record<string, any>>();
    private address = "";

    constructor(options?: unknown) {
      lastServerOptions = options;
    }

    addService(definition: { readonly serviceName?: string }, implementation: Record<string, any>): void {
      const name = definition.serviceName ?? `service-${this.implementations.size}`;
      this.implementations.set(name, implementation);
    }

    bindAsync(
      address: string,
      _credentials: unknown,
      callback: (error: Error | null) => void,
    ): void {
      this.address = address;
      servers.set(address, this);
      callback(null);
    }

    start(): void {}

    tryShutdown(callback: () => void): void {
      servers.delete(this.address);
      callback();
    }
  }

  return {
    status: {
      INVALID_ARGUMENT: 3,
      DEADLINE_EXCEEDED: 4,
      RESOURCE_EXHAUSTED: 8,
      INTERNAL: 13,
      UNAVAILABLE: 14,
      UNAUTHENTICATED: 16,
    },
    Server: FakeServer,
    ServerCredentials: {
      createInsecure: () => ({}),
    },
    loadPackageDefinition: (definition: unknown) => definition,
    __getServer: (address: string) => servers.get(address),
    __getLastServerOptions: () => lastServerOptions,
  };
});

import { startConnectionServer } from "./server.js";

function invokeUnary(
  handler: (call: unknown, callback: (error: unknown, response?: unknown) => void) => void,
  request: unknown,
  metadata?: { get: (key: string) => string[] },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    handler({ request, metadata }, (error, response) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

describe("startConnectionServer", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers Health.Check and cleans up the discovery file on shutdown", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "typocop-ladybug-server-"));
    const discoveryPath = join(tempRoot, "ladybug-server.json");
    const dbPath = join(tempRoot, "db.ladybug");
    const address = "127.0.0.1:7617";

    const server = await startConnectionServer({
      runtimeMode: "server",
      prefix: "tpc_",
      dbPath,
      host: "127.0.0.1",
      port: 7617,
      authToken: "",
      maxConcurrency: 2,
      maxQueue: 8,
      idleTtlMs: 0,
      discoveryPath,
    });

    const grpcModule = await import("@grpc/grpc-js") as unknown as {
      readonly __getServer: (serverAddress: string) => {
        readonly implementations: Map<string, Record<string, any>>;
      } | undefined;
      readonly __getLastServerOptions: () => Record<string, number>;
    };
    const boundServer = grpcModule.__getServer(address);

    try {
      expect(boundServer).toBeDefined();
      expect(grpcModule.__getLastServerOptions()).toMatchObject({
        "grpc.max_receive_message_length": 4 * 1024 * 1024,
        "grpc.max_send_message_length": 4 * 1024 * 1024,
      });
      await expect(access(discoveryPath)).resolves.toBeUndefined();

      const healthService = boundServer?.implementations.get("Health");
      expect(healthService?.Check).toBeTypeOf("function");
      await expect(invokeUnary(healthService!.Check, {})).resolves.toEqual({
        status: 1,
        message: "SERVING",
      });
    } finally {
      await server.shutdown("test");
      await expect(access(discoveryPath)).rejects.toBeDefined();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated requests when auth is enabled", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "typocop-ladybug-server-auth-"));
    const discoveryPath = join(tempRoot, "ladybug-server.json");
    const dbPath = join(tempRoot, "db.ladybug");
    const address = "127.0.0.1:7618";

    const server = await startConnectionServer({
      runtimeMode: "server",
      prefix: "tpc_",
      dbPath,
      host: "127.0.0.1",
      port: 7618,
      authToken: "secret-token",
      maxConcurrency: 2,
      maxQueue: 8,
      idleTtlMs: 0,
      discoveryPath,
    });

    const grpcModule = await import("@grpc/grpc-js") as unknown as {
      readonly __getServer: (serverAddress: string) => {
        readonly implementations: Map<string, Record<string, any>>;
      } | undefined;
    };
    const boundServer = grpcModule.__getServer(address);

    try {
      const healthService = boundServer?.implementations.get("Health");
      await expect(invokeUnary(healthService!.Check, {})).rejects.toMatchObject({
        code: 16,
      });

      await expect(
        invokeUnary(
          healthService!.Check,
          {},
          { get: (key: string) => (key === "authorization" ? ["Bearer secret-token"] : []) },
        ),
      ).resolves.toEqual({
        status: 1,
        message: "SERVING",
      });
    } finally {
      await server.shutdown("test");
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
