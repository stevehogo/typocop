import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GRPC_MAX_MESSAGE_BYTES,
  GRPC_SERVER_MIN_PING_INTERVAL_MS,
} from "../../platform/utils/limits.js";

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

    forceShutdown(): void {
      servers.delete(this.address);
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
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
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
      grpcMaxMessageBytes: DEFAULT_GRPC_MAX_MESSAGE_BYTES,
      maxConcurrency: 2,
      maxQueue: 8,
      idleTtlMs: 0,
      discoveryPath,
      shutdownGraceMs: 5_000,
      shutdownHardMs: 10_000,
      lockStaleMs: 30_000,
      lockRetries: 10,
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
        "grpc.max_receive_message_length": DEFAULT_GRPC_MAX_MESSAGE_BYTES,
        "grpc.max_send_message_length": DEFAULT_GRPC_MAX_MESSAGE_BYTES,
        // Keepalive: must accept idle client pings without GOAWAY("too_many_pings").
        "grpc.keepalive_permit_without_calls": 1,
        "grpc.http2.min_ping_interval_without_data_ms": GRPC_SERVER_MIN_PING_INTERVAL_MS,
      });
      await expect(access(discoveryPath)).resolves.toBeUndefined();

      const healthService = boundServer?.implementations.get("Health");
      expect(healthService?.Check).toBeTypeOf("function");
      const healthResponse = (await invokeUnary(healthService!.Check, {})) as {
        status: number;
        message: string;
        pid: number;
        startedAt: string;
        uptimeMs: number;
      };
      // Existing fields unchanged ...
      expect(healthResponse).toMatchObject({ status: 1, message: "SERVING" });
      // ... plus Phase F identity/liveness additions.
      expect(healthResponse.pid).toBe(process.pid);
      expect(typeof healthResponse.startedAt).toBe("string");
      expect(Number.isNaN(Date.parse(healthResponse.startedAt))).toBe(false);
      expect(healthResponse.uptimeMs).toBeGreaterThanOrEqual(0);
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
      grpcMaxMessageBytes: DEFAULT_GRPC_MAX_MESSAGE_BYTES,
      maxConcurrency: 2,
      maxQueue: 8,
      idleTtlMs: 0,
      discoveryPath,
      shutdownGraceMs: 5_000,
      shutdownHardMs: 10_000,
      lockStaleMs: 30_000,
      lockRetries: 10,
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
      ).resolves.toMatchObject({
        status: 1,
        message: "SERVING",
      });
    } finally {
      await server.shutdown("test");
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("Health flips to NOT_SERVING at the start of shutdown (Phase C)", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "typocop-ladybug-server-health-"));
    const discoveryPath = join(tempRoot, "ladybug-server.json");
    const dbPath = join(tempRoot, "db.ladybug");
    const address = "127.0.0.1:7620";

    const server = await startConnectionServer({
      runtimeMode: "server",
      prefix: "tpc_",
      dbPath,
      host: "127.0.0.1",
      port: 7620,
      authToken: "",
      grpcMaxMessageBytes: DEFAULT_GRPC_MAX_MESSAGE_BYTES,
      maxConcurrency: 2,
      maxQueue: 8,
      idleTtlMs: 0,
      discoveryPath,
      shutdownGraceMs: 5_000,
      shutdownHardMs: 10_000,
      lockStaleMs: 30_000,
      lockRetries: 10,
    });

    const grpcModule = await import("@grpc/grpc-js") as unknown as {
      readonly __getServer: (serverAddress: string) => {
        readonly implementations: Map<string, Record<string, any>>;
      } | undefined;
    };
    const boundServer = grpcModule.__getServer(address);
    const healthService = boundServer?.implementations.get("Health");

    await expect(invokeUnary(healthService!.Check, {})).resolves.toMatchObject({
      status: 1,
      message: "SERVING",
    });

    // Start shutdown but do not await: markDraining() runs synchronously at the
    // very start, so Health must report NOT_SERVING before the DB even closes.
    const shutdownPromise = server.shutdown("test");
    await expect(invokeUnary(healthService!.Check, {})).resolves.toMatchObject({
      status: 2,
      message: "NOT_SERVING",
    });

    await shutdownPromise;
    await rm(tempRoot, { recursive: true, force: true });
  });
});
