import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fc from "fast-check";

const { mockEnsureServerAndConnect } = vi.hoisted(() => ({
  mockEnsureServerAndConnect: vi.fn(),
}));

const mockPoolRelease = vi.fn().mockResolvedValue(undefined);
const mockPoolAcquire = vi.fn().mockResolvedValue({
  connection: { query: vi.fn() },
  database: { close: vi.fn() },
  dbPath: "/tmp/test.ladybug",
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
  release: vi.fn().mockResolvedValue(undefined),
});

vi.mock("./pool-registry.js", () => ({
  getPool: vi.fn(async () => ({
    acquire: mockPoolAcquire,
    release: mockPoolRelease,
    drain: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn(),
  })),
}));

vi.mock("./ladybug-graph-adapter.js", () => ({
  LadybugGraphAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.initializeSchema = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock("./ladybug-vector-adapter.js", () => ({
  LadybugVectorAdapter: vi.fn(function (this: Record<string, unknown>) {
    this.createTables = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock("../embeddings/huggingface-embedding-adapter.js", () => ({
  HuggingFaceEmbeddingAdapter: vi.fn(function () {}),
}));

vi.mock("../embeddings/ollama-embedding-adapter.js", () => ({
  OllamaEmbeddingAdapter: vi.fn(function () {}),
}));

vi.mock("../embeddings/noop-embedding-adapter.js", () => ({
  NoOpEmbeddingAdapter: vi.fn(function () {}),
}));

vi.mock("../remote-transport/autostart.js", () => ({
  ensureServerAndConnect: mockEnsureServerAndConnect,
}));

import { createDatabaseAdapter, LadybugDatabaseAdapter } from "./database-adapter.js";
import type { EmbeddingAdapter } from "../../core/ports/persistence.js";
import { DEFAULT_GRPC_MAX_MESSAGE_BYTES } from "../../platform/utils/limits.js";

// Embedding is injected since §14; this stub stands in for any provider.
const stubEmbedding = {
  isEnabled: () => false,
  embedText: async () => null,
  getDimensions: () => 0,
} as unknown as EmbeddingAdapter;

function makeConfig(runtimeMode: "server" | "client") {
  return {
    prefix: "tenant_",
    ollama: {
      enabled: false,
      url: "http://localhost:11434",
      model: "mxbai-embed-large",
      dimensions: 1024,
    },
    embedding: {
      provider: "none" as const,
      huggingface: {
        model: "mixedbread-ai/mxbai-embed-large-v1",
        dtype: "fp32" as const,
        dimensions: 1024,
        pooling: "cls" as const,
      },
    },
    ladybugdb: {
      dbPath: "/tmp/test.ladybug",
      runtimeMode,
      serverUrl: "grpc://127.0.0.1:7617",
      serverHost: "127.0.0.1",
      serverPort: 7617,
      serverAuthToken: "secret-token",
      grpcMaxMessageBytes: DEFAULT_GRPC_MAX_MESSAGE_BYTES,
      serverMaxConcurrency: 4,
      serverMaxQueue: 256,
      serverAutostart: true,
      serverStartupTimeoutMs: 10_000,
      serverLockPath: "/tmp/ladybug.lock",
      serverDiscoveryPath: "/tmp/ladybug.json",
      serverIdleTtlMs: 0,
    },
    loadedAt: new Date(),
    source: "default" as const,
  };
}

describe("createDatabaseAdapter — property tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Property 1: returns the correct adapter type for each runtimeMode", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("server" as const, "client" as const), async (runtimeMode) => {
        vi.clearAllMocks();
        const remoteAdapter = {
          initialize: vi.fn(),
          close: vi.fn(),
          getGraphAdapter: vi.fn(),
          getVectorAdapter: vi.fn(),
          getEmbeddingAdapter: vi.fn(),
        };
        mockEnsureServerAndConnect.mockResolvedValue(remoteAdapter);

        const adapter = await createDatabaseAdapter(makeConfig(runtimeMode), stubEmbedding);

        if (runtimeMode === "server") {
          expect(adapter).toBeInstanceOf(LadybugDatabaseAdapter);
          expect(mockPoolAcquire).toHaveBeenCalled();
          expect(mockEnsureServerAndConnect).not.toHaveBeenCalled();
        } else {
          expect(adapter).toBe(remoteAdapter);
          expect(mockEnsureServerAndConnect).toHaveBeenCalledOnce();
        }
      }),
      { numRuns: 30 },
    );
  });
});
