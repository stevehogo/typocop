/**
 * Unit tests for LadybugDatabaseAdapter and createDatabaseAdapter factory.
 * Requirements: 1.1, 4.5, 5.1, 6.1, 6.3, 8.1
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmbeddingProvider, FullConfig } from "../config/types.js";

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
vi.mock("./ollama-embedding-adapter.js", () => ({
  OllamaEmbeddingAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.__type = "ollama-embedding"; this.isEnabled = () => true;
  }),
}));
vi.mock("./noop-embedding-adapter.js", () => ({
  NoOpEmbeddingAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.__type = "noop-embedding"; this.isEnabled = () => false;
  }),
}));
vi.mock("./huggingface-embedding-adapter.js", () => ({
  HuggingFaceEmbeddingAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.__type = "huggingface-embedding"; this.isEnabled = () => true;
  }),
}));
const { mockEnsureServerAndConnect } = vi.hoisted(() => ({
  mockEnsureServerAndConnect: vi.fn(),
}));
vi.mock("./autostart.js", () => ({
  ensureServerAndConnect: mockEnsureServerAndConnect,
}));

import { getPool } from "./pool-registry.js";
import { LadybugGraphAdapter } from "./ladybug-graph-adapter.js";
import { LadybugVectorAdapter } from "./ladybug-vector-adapter.js";
import { OllamaEmbeddingAdapter } from "./ollama-embedding-adapter.js";
import { NoOpEmbeddingAdapter } from "./noop-embedding-adapter.js";
import { HuggingFaceEmbeddingAdapter } from "./huggingface-embedding-adapter.js";
import { LadybugDatabaseAdapter, createDatabaseAdapter } from "./database-adapter.js";

const mockedGetPool = vi.mocked(getPool);
const MockedGraphAdapter = vi.mocked(LadybugGraphAdapter);
const MockedVectorAdapter = vi.mocked(LadybugVectorAdapter);
const MockedOllamaAdapter = vi.mocked(OllamaEmbeddingAdapter);
const MockedNoOpAdapter = vi.mocked(NoOpEmbeddingAdapter);
const MockedHFAdapter = vi.mocked(HuggingFaceEmbeddingAdapter);

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
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await adapter.initialize();
      expect(mockedGetPool).toHaveBeenCalledWith("/tmp/test.ladybug");
      expect(mockPoolAcquire).toHaveBeenCalledOnce();
    });

    it("should create LadybugGraphAdapter with pooled connection and prefix", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await adapter.initialize();
      expect(MockedGraphAdapter).toHaveBeenCalledWith(mockConn, "TEST_");
    });

    it("should create LadybugVectorAdapter with pooled connection and prefix", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await adapter.initialize();
      expect(MockedVectorAdapter).toHaveBeenCalledWith(mockConn, "TEST_");
    });

    it("should call vectorAdapter.createTables() during initialization", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await adapter.initialize();
      expect(mockCreateTables).toHaveBeenCalledOnce();
    });

    it("should create OllamaEmbeddingAdapter when provider is 'ollama' (Req 4.5)", async () => {
      const config = makeConfig(true);
      const adapter = new LadybugDatabaseAdapter(config);
      await adapter.initialize();
      expect(MockedOllamaAdapter).toHaveBeenCalledWith(config.ollama);
      expect(MockedNoOpAdapter).not.toHaveBeenCalled();
    });

    it("should create NoOpEmbeddingAdapter when provider is 'none' (Req 5.1)", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await adapter.initialize();
      expect(MockedNoOpAdapter).toHaveBeenCalled();
      expect(MockedOllamaAdapter).not.toHaveBeenCalled();
    });
  });

  describe("close() (Req 8.1)", () => {
    it("should release connection back to pool instead of closing directly", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await adapter.initialize();
      await adapter.close();
      expect(mockPoolRelease).toHaveBeenCalledWith(mockPooledConnection);
    });

    it("should not throw when called before initialize()", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await expect(adapter.close()).resolves.toBeUndefined();
    });

    it("should not release twice on double close()", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await adapter.initialize();
      await adapter.close();
      await adapter.close();
      expect(mockPoolRelease).toHaveBeenCalledOnce();
    });
  });

  describe("getters (Req 1.1)", () => {
    it("should return the graph adapter after initialization", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await adapter.initialize();
      expect((adapter.getGraphAdapter() as Record<string, unknown>).__type).toBe("graph");
    });

    it("should return the vector adapter after initialization", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await adapter.initialize();
      expect((adapter.getVectorAdapter() as Record<string, unknown>).__type).toBe("vector");
    });

    it("should return the embedding adapter after initialization", async () => {
      const adapter = new LadybugDatabaseAdapter(makeConfig(false));
      await adapter.initialize();
      expect((adapter.getEmbeddingAdapter() as Record<string, unknown>).__type).toBe("noop-embedding");
    });

    it("should throw when getGraphAdapter() is called before initialize()", () => {
      expect(() => new LadybugDatabaseAdapter(makeConfig(false)).getGraphAdapter()).toThrow("not initialized");
    });

    it("should throw when getVectorAdapter() is called before initialize()", () => {
      expect(() => new LadybugDatabaseAdapter(makeConfig(false)).getVectorAdapter()).toThrow("not initialized");
    });

    it("should throw when getEmbeddingAdapter() is called before initialize()", () => {
      expect(() => new LadybugDatabaseAdapter(makeConfig(false)).getEmbeddingAdapter()).toThrow("not initialized");
    });
  });
});

describe("createDatabaseAdapter", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should return an initialized DatabaseAdapter using pool", async () => {
    const adapter = await createDatabaseAdapter(makeConfig(false));
    expect(mockedGetPool).toHaveBeenCalledOnce();
    expect(mockPoolAcquire).toHaveBeenCalledOnce();
    expect(adapter.getGraphAdapter()).toBeDefined();
    expect(adapter.getVectorAdapter()).toBeDefined();
    expect(adapter.getEmbeddingAdapter()).toBeDefined();
  });

  it("should select OllamaEmbeddingAdapter when ollama.enabled is true", async () => {
    const adapter = await createDatabaseAdapter(makeConfig(true));
    expect(MockedOllamaAdapter).toHaveBeenCalled();
    expect((adapter.getEmbeddingAdapter() as Record<string, unknown>).__type).toBe("ollama-embedding");
  });

  it("should select NoOpEmbeddingAdapter when ollama.enabled is false", async () => {
    const adapter = await createDatabaseAdapter(makeConfig(false));
    expect(MockedNoOpAdapter).toHaveBeenCalled();
    expect((adapter.getEmbeddingAdapter() as Record<string, unknown>).__type).toBe("noop-embedding");
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

    const adapter = await createDatabaseAdapter(config);

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
      expect.objectContaining({
        embeddingConfig: config.embedding,
        ollamaConfig: config.ollama,
      }),
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

    await expect(createDatabaseAdapter(config)).rejects.toThrow(
      "ladybugdb.serverUrl must be a valid grpc:// URL",
    );
  });
});

describe("Provider-based adapter selection (Req 6.1-6.4)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should create HuggingFaceEmbeddingAdapter when provider is 'huggingface'", async () => {
    const config = makeProviderConfig("huggingface");
    const adapter = await createDatabaseAdapter(config);
    expect(MockedHFAdapter).toHaveBeenCalledWith(config.embedding.huggingface);
    expect(adapter.getEmbeddingAdapter()).toBeDefined();
  });

  it("should create OllamaEmbeddingAdapter when provider is 'ollama'", async () => {
    const config = makeProviderConfig("ollama");
    const adapter = await createDatabaseAdapter(config);
    expect(MockedOllamaAdapter).toHaveBeenCalledWith(config.ollama);
    expect(adapter.getEmbeddingAdapter()).toBeDefined();
  });

  it("should create NoOpEmbeddingAdapter when provider is 'none'", async () => {
    const adapter = await createDatabaseAdapter(makeProviderConfig("none"));
    expect(MockedNoOpAdapter).toHaveBeenCalled();
    expect(adapter.getEmbeddingAdapter()).toBeDefined();
  });

  it("should set __type to 'huggingface-embedding' when provider is 'huggingface'", async () => {
    const adapter = await createDatabaseAdapter(makeProviderConfig("huggingface"));
    const embedding = adapter.getEmbeddingAdapter();
    expect((embedding as Record<string, unknown>).__type).toBe("huggingface-embedding");
  });

  it("should set __type to 'ollama-embedding' when provider is 'ollama'", async () => {
    const adapter = await createDatabaseAdapter(makeProviderConfig("ollama"));
    const embedding = adapter.getEmbeddingAdapter();
    expect((embedding as Record<string, unknown>).__type).toBe("ollama-embedding");
  });

  it("should set __type to 'noop-embedding' when provider is 'none'", async () => {
    const adapter = await createDatabaseAdapter(makeProviderConfig("none"));
    const embedding = adapter.getEmbeddingAdapter();
    expect((embedding as Record<string, unknown>).__type).toBe("noop-embedding");
  });

  it("should instantiate exactly one adapter type per provider", async () => {
    for (const provider of ["huggingface", "ollama", "none"] as const) {
      vi.clearAllMocks();
      await createDatabaseAdapter(makeProviderConfig(provider));
      const counts = [
        MockedHFAdapter.mock.calls.length,
        MockedOllamaAdapter.mock.calls.length,
        MockedNoOpAdapter.mock.calls.length,
      ];
      expect(counts.filter((c) => c === 1)).toHaveLength(1);
      expect(counts.filter((c) => c === 0)).toHaveLength(2);
    }
  });
});

describe("Sub-adapters work with pooled connections (Req 8.1, Task 4.3)", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should pass the pooled connection.connection to graph and vector adapters", async () => {
    const adapter = new LadybugDatabaseAdapter(makeConfig(false));
    await adapter.initialize();

    // Graph adapter receives the Connection from the PooledConnection
    expect(MockedGraphAdapter).toHaveBeenCalledWith(mockPooledConnection.connection, "TEST_");
    // Vector adapter receives the same Connection
    expect(MockedVectorAdapter).toHaveBeenCalledWith(mockPooledConnection.connection, "TEST_");
  });
});
