/**
 * Unit tests for LadybugDatabaseAdapter and createDatabaseAdapter factory.
 *
 * Since PR4 (§14) the embedding adapter is INJECTED, so these tests pass a stub
 * EmbeddingAdapter and assert it is wired through unchanged. Provider-selection
 * coverage lives in embedding-factory.test.ts.
 *
 * Requirements: 1.1, 4.5, 5.1, 6.1, 6.3, 8.1
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmbeddingProvider, FullConfig } from "../platform/config/types.js";
import type { EmbeddingAdapter } from "../core/ports/persistence.js";

// ─── Mocks ────────────────────────────────────────────────────────────────────
const mockConn = { query: vi.fn(), init: vi.fn(), close: vi.fn() };
const mockDatabase = { init: vi.fn(), close: vi.fn() };
const mockCreateTables = vi.fn().mockResolvedValue(undefined);

const mockPooledConnection = {
  connection: mockConn,
  database: mockDatabase,
  dbPath: "/tmp/test.ladybug",
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
  release: vi.fn().mockResolvedValue(undefined),
};

const mockPoolRelease = vi.fn().mockResolvedValue(undefined);
const mockPoolAcquire = vi.fn().mockResolvedValue(mockPooledConnection);
const mockPool = {
  acquire: mockPoolAcquire,
  release: mockPoolRelease,
  drain: vi.fn().mockResolvedValue(undefined),
  stats: vi.fn(),
};

vi.mock("./pool-registry.js", () => ({
  getPool: vi.fn(async () => mockPool),
}));
vi.mock("./ladybug-graph-adapter.js", () => ({
  LadybugGraphAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.__type = "graph"; this.initializeSchema = vi.fn().mockResolvedValue(undefined);
  }),
}));
vi.mock("./ladybug-vector-adapter.js", () => ({
  LadybugVectorAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.__type = "vector"; this.createTables = mockCreateTables;
  }),
}));
const { mockEnsureServerAndConnect } = vi.hoisted(() => ({
  mockEnsureServerAndConnect: vi.fn(),
}));
vi.mock("../infrastructure/remote-transport/autostart.js", () => ({
  ensureServerAndConnect: mockEnsureServerAndConnect,
}));

import { getPool } from "./pool-registry.js";
import { LadybugGraphAdapter } from "./ladybug-graph-adapter.js";
import { LadybugVectorAdapter } from "./ladybug-vector-adapter.js";
import { LadybugDatabaseAdapter, createDatabaseAdapter } from "./database-adapter.js";

const mockedGetPool = vi.mocked(getPool);
const MockedGraphAdapter = vi.mocked(LadybugGraphAdapter);
const MockedVectorAdapter = vi.mocked(LadybugVectorAdapter);

// Injected stub embedding adapter — provider selection is no longer the
// adapter's concern (§14); these tests only verify it is wired through.
const stubEmbedding = {
  __type: "stub-embedding",
  isEnabled: () => false,
  embedText: async () => null,
  getDimensions: () => 0,
} as unknown as EmbeddingAdapter;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const HF_DEFAULTS = { model: "mixedbread-ai/mxbai-embed-large-v1", dtype: "fp32" as const, dimensions: 1024, pooling: "cls" as const };

function makeConfig(ollamaEnabled: boolean): FullConfig {
  return makeProviderConfig(ollamaEnabled ? "ollama" : "none");
}
function makeProviderConfig(provider: EmbeddingProvider): FullConfig {
  return {
    prefix: "TEST_",
    ollama: { enabled: provider === "ollama", url: "http://localhost:11434", model: "mxbai-embed-large", dimensions: 1024 },
    embedding: { provider, huggingface: HF_DEFAULTS },
    ladybugdb: {
      dbPath: "/tmp/test.ladybug",
      runtimeMode: "server",
      serverUrl: "grpc://127.0.0.1:7617",
      serverHost: "127.0.0.1",
      serverPort: 7617,
      serverAuthToken: "",
      serverMaxConcurrency: 4,
      serverMaxQueue: 256,
      serverAutostart: false,
      serverStartupTimeoutMs: 10_000,
      serverLockPath: "/tmp/ladybug-server.lock",
      serverDiscoveryPath: "/tmp/ladybug-server.json",
      serverIdleTtlMs: 0,
    },
    loadedAt: new Date(),
    source: "default",
  };
}

describe("LadybugDatabaseAdapter", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe("initialize() (Req 8.1)", () => {
    it("should acquire a connection from the pool via getPool()", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
      await adapter.initialize();
      expect(mockedGetPool).toHaveBeenCalledWith("/tmp/test.ladybug");
      expect(mockPoolAcquire).toHaveBeenCalledOnce();
    });

    it("should create LadybugGraphAdapter with pooled connection and prefix", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
      await adapter.initialize();
      expect(MockedGraphAdapter).toHaveBeenCalledWith(mockConn, "TEST_");
    });

    it("should create LadybugVectorAdapter with pooled connection and prefix", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
      await adapter.initialize();
      expect(MockedVectorAdapter).toHaveBeenCalledWith(mockConn, "TEST_");
    });

    it("should call vectorAdapter.createTables() during initialization", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
      await adapter.initialize();
      expect(mockCreateTables).toHaveBeenCalledOnce();
    });

    it("should expose the injected embedding adapter after initialization", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(true), stubEmbedding);
      await adapter.initialize();
      expect(adapter.getEmbeddingAdapter()).toBe(stubEmbedding);
    });
  });

  describe("close() (Req 8.1)", () => {
    it("should release connection back to pool instead of closing directly", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
      await adapter.initialize();
      await adapter.close();
      expect(mockPoolRelease).toHaveBeenCalledWith(mockPooledConnection);
    });

    it("should not throw when called before initialize()", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
      await expect(adapter.close()).resolves.toBeUndefined();
    });

    it("should not release twice on double close()", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
      await adapter.initialize();
      await adapter.close();
      await adapter.close();
      expect(mockPoolRelease).toHaveBeenCalledOnce();
    });
  });

  describe("getters (Req 1.1)", () => {
    it("should return the graph adapter after initialization", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
      await adapter.initialize();
      expect((adapter.getGraphAdapter() as unknown as Record<string, unknown>).__type).toBe("graph");
    });

    it("should return the vector adapter after initialization", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
      await adapter.initialize();
      expect((adapter.getVectorAdapter() as unknown as Record<string, unknown>).__type).toBe("vector");
    });

    it("should return the embedding adapter after initialization", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
      await adapter.initialize();
      expect((adapter.getEmbeddingAdapter() as unknown as Record<string, unknown>).__type).toBe("stub-embedding");
    });

    it("should throw when getGraphAdapter() is called before initialize()", () => {
      expect(() => new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding).getGraphAdapter()).toThrow("not initialized");
    });

    it("should throw when getVectorAdapter() is called before initialize()", () => {
      expect(() => new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding).getVectorAdapter()).toThrow("not initialized");
    });

    it("should throw when getEmbeddingAdapter() is called before initialize()", () => {
      expect(() => new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding).getEmbeddingAdapter()).toThrow("not initialized");
    });
  });
});

describe("createDatabaseAdapter", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should return an initialized DatabaseAdapter using pool", async () => {
    const adapter = await createDatabaseAdapter(makeConfig(false), stubEmbedding);
    expect(mockedGetPool).toHaveBeenCalledOnce();
    expect(mockPoolAcquire).toHaveBeenCalledOnce();
    expect(adapter.getGraphAdapter()).toBeDefined();
    expect(adapter.getVectorAdapter()).toBeDefined();
    expect(adapter.getEmbeddingAdapter()).toBe(stubEmbedding);
  });

  it("wires the injected embedding adapter through to the adapter", async () => {
    const adapter = await createDatabaseAdapter(makeConfig(true), stubEmbedding);
    expect(adapter.getEmbeddingAdapter()).toBe(stubEmbedding);
  });

  it("returns a remote adapter in client mode after ensuring the server", async () => {
    const remoteAdapter = {
      initialize: vi.fn(),
      close: vi.fn(),
      getGraphAdapter: vi.fn(),
      getVectorAdapter: vi.fn(),
      getEmbeddingAdapter: vi.fn(),
    };
    mockEnsureServerAndConnect.mockResolvedValue(remoteAdapter);
    const config = {
      ...makeConfig(false),
      ladybugdb: {
        ...makeConfig(false).ladybugdb,
        runtimeMode: "client" as const,
        serverAutostart: true,
        serverAuthToken: "secret-token",
      },
    };

    const adapter = await createDatabaseAdapter(config, stubEmbedding);

    expect(mockEnsureServerAndConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeMode: "client",
        prefix: "TEST_",
        dbPath: "/tmp/test.ladybug",
        serverUrl: "grpc://127.0.0.1:7617",
        authToken: "secret-token",
        autostart: true,
        startupTimeoutMs: 10_000,
        lockPath: "/tmp/ladybug-server.lock",
        discoveryPath: "/tmp/ladybug-server.json",
      }),
      expect.objectContaining({ embeddingAdapter: stubEmbedding }),
    );
    expect(adapter).toBe(remoteAdapter);
    expect(mockedGetPool).not.toHaveBeenCalled();
  });

  it("validates client mode serverUrl before creating a remote adapter", async () => {
    const config = {
      ...makeConfig(false),
      ladybugdb: {
        ...makeConfig(false).ladybugdb,
        runtimeMode: "client" as const,
        serverUrl: "http://127.0.0.1:7617",
      },
    };

    await expect(createDatabaseAdapter(config, stubEmbedding)).rejects.toThrow(
      "ladybugdb.serverUrl must be a valid grpc:// URL",
    );
  });
});

describe("Sub-adapters work with pooled connections (Req 8.1, Task 4.3)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should pass the pooled connection.connection to graph and vector adapters", async () => {
    const adapter = new LadybugDatabaseAdapter(makeConfig(false), stubEmbedding);
    await adapter.initialize();

    // Graph adapter receives the Connection from the PooledConnection
    expect(MockedGraphAdapter).toHaveBeenCalledWith(mockPooledConnection.connection, "TEST_");
    // Vector adapter receives the same Connection
    expect(MockedVectorAdapter).toHaveBeenCalledWith(mockPooledConnection.connection, "TEST_");
  });
});
