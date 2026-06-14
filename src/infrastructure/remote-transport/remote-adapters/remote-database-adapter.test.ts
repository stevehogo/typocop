import { describe, expect, it, vi } from "vitest";

import type { LadybugClientConfig } from "../../../platform/config/types.js";
import { DEFAULT_GRPC_MAX_MESSAGE_BYTES } from "../../../platform/utils/limits.js";
import { RemoteDatabaseAdapter } from "./remote-database-adapter.js";
import type { RpcClientBundle, UnaryRpcMethod } from "../remote-rpc-client.js";

vi.mock("@grpc/proto-loader", () => ({
  loadSync: vi.fn(() => ({})),
}));

vi.mock("@grpc/grpc-js", () => {
  class Metadata {
    private readonly values = new Map<string, string[]>();

    set(key: string, value: string): void {
      this.values.set(key, [value]);
    }

    get(key: string): string[] {
      return this.values.get(key) || [];
    }
  }

  return {
    status: {
      UNAVAILABLE: 14,
      DEADLINE_EXCEEDED: 4,
      RESOURCE_EXHAUSTED: 8,
    },
    Metadata,
    credentials: {
      createInsecure: () => ({}),
    },
    loadPackageDefinition: (definition: unknown) => definition,
  };
});

interface MetadataLike {
  get(key: string): string[];
}

interface CapturedCall {
  readonly request: { readonly metadata: { readonly timeoutMs: number; readonly prefix: string } };
  readonly metadata: MetadataLike;
  readonly deadline: Date;
}

interface FakeClient {
  readonly close: ReturnType<typeof vi.fn>;
  readonly waitForReady: ReturnType<typeof vi.fn>;
  readonly QueryNodes?: UnaryRpcMethod<{
    readonly metadata: { readonly timeoutMs: number; readonly prefix: string };
    readonly label: string;
    readonly filterJson: string;
  }, { readonly nodes: unknown[] }>;
}

const baseConfig: LadybugClientConfig = {
  runtimeMode: "client",
  prefix: "tpc_",
  dbPath: "/tmp/db.ladybug",
  serverUrl: "grpc://127.0.0.1:7617",
  authToken: "token-123",
  grpcMaxMessageBytes: DEFAULT_GRPC_MAX_MESSAGE_BYTES,
  autostart: false,
  startupTimeoutMs: 5_000,
  lockPath: "/tmp/server.lock",
  discoveryPath: "/tmp/discovery.json",
};

function createNoopClient(): FakeClient {
  return {
    close: vi.fn(),
    waitForReady: vi.fn((_deadline: Date, callback: (error?: Error | null) => void) => {
      callback(null);
    }),
  };
}

describe("RemoteDatabaseAdapter", () => {
  it("initializes and closes gRPC clients", async () => {
    const graphClient = createNoopClient();
    const vectorClient = createNoopClient();

    const adapter = new RemoteDatabaseAdapter(baseConfig, {
      createClients: () =>
        ({
          graph: graphClient,
          vector: vectorClient,
        }) as unknown as RpcClientBundle,
      // Embedding is injected since §14 (no internal provider switch).
      embeddingAdapter: { isEnabled: () => false, embedText: async () => null, getDimensions: () => 0 },
    });

    await adapter.initialize();

    expect(adapter.getGraphAdapter()).toBeDefined();
    expect(adapter.getVectorAdapter()).toBeDefined();
    expect(adapter.getEmbeddingAdapter().isEnabled()).toBe(false);

    await adapter.close();
    expect(graphClient.close).toHaveBeenCalledOnce();
    expect(vectorClient.close).toHaveBeenCalledOnce();
  });

  it("passes configured gRPC message limit to client construction", async () => {
    const createClients = vi.fn(() => ({
      graph: createNoopClient(),
      vector: createNoopClient(),
    }) as unknown as RpcClientBundle);
    const adapter = new RemoteDatabaseAdapter(
      { ...baseConfig, grpcMaxMessageBytes: 8_388_608 },
      { createClients },
    );

    await adapter.initialize();

    expect(createClients).toHaveBeenCalledWith("127.0.0.1:7617", 8_388_608);
  });

  it("includes prefix, timeout, and auth metadata in requests", async () => {
    let captured: CapturedCall | null = null as CapturedCall | null;

    const graphClient: FakeClient = {
      ...createNoopClient(),
      QueryNodes(request, metadata, options, callback) {
        captured = {
          request,
          metadata,
          deadline: options.deadline,
        };
        callback(null, { nodes: [] });
      },
    };

    const adapter = new RemoteDatabaseAdapter(baseConfig, {
      createClients: () =>
        ({
          graph: graphClient,
          vector: createNoopClient(),
        }) as unknown as RpcClientBundle,
    });

    await adapter.initialize();
    await adapter.getGraphAdapter().queryNodes("Symbol");

    expect(captured?.request.metadata.prefix).toBe("tpc_");
    expect(captured?.request.metadata.timeoutMs).toBe(30_000);
    expect(captured?.metadata.get("authorization")[0]).toBe("Bearer token-123");
    expect(captured?.metadata.get("x-timeout-ms")[0]).toBe("30000");
    expect(captured?.deadline.getTime()).toBeGreaterThan(Date.now());
  });

  it("reconnects and retries once on transient gRPC errors", async () => {
    const firstGraph: FakeClient = {
      ...createNoopClient(),
      QueryNodes(_request, _metadata, _options, callback) {
        callback(Object.assign(new Error("server unavailable"), { code: 14 }));
      },
    };
    const secondGraph: FakeClient = {
      ...createNoopClient(),
      QueryNodes(_request, _metadata, _options, callback) {
        callback(null, { nodes: [] });
      },
    };

    const createClients = vi
      .fn()
      .mockReturnValueOnce({
        graph: firstGraph,
        vector: createNoopClient(),
      } as unknown as RpcClientBundle)
      .mockReturnValueOnce({
        graph: secondGraph,
        vector: createNoopClient(),
      } as unknown as RpcClientBundle);

    const adapter = new RemoteDatabaseAdapter(baseConfig, { createClients });
    await adapter.initialize();

    await expect(adapter.getGraphAdapter().queryNodes("Symbol")).resolves.toEqual([]);
    expect(createClients).toHaveBeenCalledTimes(2);
    expect(firstGraph.close).toHaveBeenCalledOnce();
  });
});
