/**
 * Unit tests for CLI executor with DatabaseAdapter.
 * Requirements: 7.1, 5.1
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { executeCLI } from "./executor.js";
import { CLICommand } from "./parser.js";
import ora from "ora";
import * as pipeline from "../../application/indexing/pipeline.js";
import * as dbAdapter from "../../infrastructure/persistence/database-adapter.js";

vi.mock("ora", () => {
  const oraMock = {
    start: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    text: "",
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  };
  return { default: vi.fn(() => oraMock) };
});

// ── Mock DatabaseAdapter via vi.mock factory (hoisted) ────────────────────────

vi.mock("../../infrastructure/persistence/database-adapter.js", () => ({
  createDatabaseAdapter: vi.fn(),
}));

vi.mock("../../infrastructure/embeddings/embedding-factory.js", () => ({
  createEmbeddingAdapterFromConfig: vi.fn(() => ({
    isEnabled: () => false, embedText: async () => null, getDimensions: () => 0,
  })),
}));

vi.mock("../../application/indexing/pipeline.js", () => ({
  runIndexingPipeline: vi.fn().mockResolvedValue({
    symbols: [],
    relationships: [],
    clusters: [],
    processes: [],
    externalDependencyCount: 0,
    skippedFiles: 0,
    embeddingCount: 0,
    // A5: the executor reads metrics for its reused/parsed reporting; the real
    // pipeline always populates this. A minimal stub is enough for these tests.
    metrics: { filesScanned: 0, filesParsed: 0, skippedFiles: 0, embeddingAttempts: 0 },
  }),
}));

vi.mock("../../platform/config/index.js", () => ({
  configurationManager: {
    initialize: vi.fn().mockResolvedValue(undefined),
    getPrefix: vi.fn().mockReturnValue("tpc_"),
    getConfiguration: vi.fn().mockReturnValue({
      prefix: "tpc_",
      ollama: { enabled: false, url: "http://localhost:11434", model: "qwen3-embedding:4b", dimensions: 2560 },
      ladybugdb: { dbPath: "/tmp/test.ladybug" },
      loadedAt: new Date(),
      source: "default",
    }),
  },
}));

// ── Create mock adapter in beforeEach (not at module level) ───────────────────

let mockGraphAdapter: Record<string, ReturnType<typeof vi.fn>>;
let mockVectorAdapter: Record<string, ReturnType<typeof vi.fn>>;
let mockAdapter: Record<string, ReturnType<typeof vi.fn> | (() => unknown)>;

function resetMockAdapter(): void {
  mockGraphAdapter = {
    createNode: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue(undefined),
    queryNodes: vi.fn().mockResolvedValue([]),
    queryRelationships: vi.fn().mockResolvedValue([]),
    deleteNodesByLabel: vi.fn().mockResolvedValue(0),
    deleteRelationshipsByType: vi.fn().mockResolvedValue(0),
    runCypher: vi.fn().mockResolvedValue([]),
    runCypherWrite: vi.fn().mockResolvedValue(undefined),
  };

  mockVectorAdapter = {
    createTables: vi.fn().mockResolvedValue(undefined),
    indexSymbol: vi.fn().mockResolvedValue(undefined),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn().mockResolvedValue(0),
  };

  const mockEmbeddingAdapter = {
    isEnabled: vi.fn().mockReturnValue(false),
    embedText: vi.fn().mockResolvedValue(null),
    getDimensions: vi.fn().mockReturnValue(2560),
  };

  mockAdapter = {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getGraphAdapter: vi.fn().mockReturnValue(mockGraphAdapter),
    getVectorAdapter: vi.fn().mockReturnValue(mockVectorAdapter),
    getEmbeddingAdapter: vi.fn().mockReturnValue(mockEmbeddingAdapter),
  };

  vi.mocked(dbAdapter.createDatabaseAdapter).mockResolvedValue(mockAdapter as never);
}

describe("executeCLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockAdapter();
  });

  it("executes the status command and reports symbol/relationship counts", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const command: CLICommand = { type: "status" };

    await executeCLI(command);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Knowledge Graph Status:"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Symbols:"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Relationships:"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Last Indexed:"));
  });

  it("executes the reindex command and reports completion", async () => {
    const command: CLICommand = { type: "reindex", dbPath: "./db" };

    await executeCLI(command);

    expect(ora).toHaveBeenCalledWith(expect.stringContaining("Reindexing database at ./db"));
    const oraInstance = vi.mocked(ora)("./db");
    expect(oraInstance.succeed).toHaveBeenCalledWith(expect.stringContaining("Reindexing complete."));
  });

  it("executes the parse command and reports statistics", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const command: CLICommand = {
      type: "parse",
      config: { sourcePath: "./src", language: "typescript", verbose: false },
    };

    await executeCLI(command);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Initializing indexing for typescript"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Statistics:"));
    const oraInstance = vi.mocked(ora)("Starting");
    expect(oraInstance.succeed).toHaveBeenCalledWith(expect.stringContaining("Indexing completed successfully."));
  });

  it("shows verbose info message when verbose mode is enabled", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const command: CLICommand = {
      type: "parse",
      config: { sourcePath: "./src", language: "typescript", verbose: true },
    };

    await executeCLI(command);

    const oraInstance = vi.mocked(ora)("Starting");
    expect(oraInstance.info).toHaveBeenCalledWith("Verbose mode enabled.");
  });

  it("creates DatabaseAdapter from config for parse command", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const command: CLICommand = {
      type: "parse",
      config: { sourcePath: "./src", language: "typescript", verbose: false },
    };

    await executeCLI(command);

    expect(dbAdapter.createDatabaseAdapter).toHaveBeenCalled();
    expect(mockAdapter.close).toHaveBeenCalled();
  });

  it("creates DatabaseAdapter from config for status command", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const command: CLICommand = { type: "status" };

    await executeCLI(command);

    expect(dbAdapter.createDatabaseAdapter).toHaveBeenCalled();
    expect(mockAdapter.close).toHaveBeenCalled();
  });

  it("passes adapter to pipeline config", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const command: CLICommand = {
      type: "parse",
      config: { sourcePath: "./src", language: "typescript", verbose: false },
    };

    await executeCLI(command);

    expect(pipeline.runIndexingPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "./src",
        language: "typescript",
        verbose: false,
        adapter: mockAdapter,
      }),
    );
  });

  // ── Refresh flag tests ────────────────────────────────────────────────────

  describe("parse command with refresh flag", () => {
    it("calls adapter graph/vector clearing when refresh is true", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const command: CLICommand = {
        type: "parse",
        config: { sourcePath: "./src", language: "typescript", verbose: false, refresh: true },
      };

      await executeCLI(command);

      expect(mockGraphAdapter.deleteNodesByLabel).toHaveBeenCalled();
      expect(mockVectorAdapter.deleteAll).toHaveBeenCalled();
    });

    it("skips clearing when refresh is false", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const command: CLICommand = {
        type: "parse",
        config: { sourcePath: "./src", language: "typescript", verbose: false, refresh: false },
      };

      await executeCLI(command);

      expect(mockGraphAdapter.deleteNodesByLabel).not.toHaveBeenCalled();
      expect(mockVectorAdapter.deleteAll).not.toHaveBeenCalled();
    });

    it("skips clearing when refresh is undefined", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const command: CLICommand = {
        type: "parse",
        config: { sourcePath: "./src", language: "typescript", verbose: false },
      };

      await executeCLI(command);

      expect(mockGraphAdapter.deleteNodesByLabel).not.toHaveBeenCalled();
      expect(mockVectorAdapter.deleteAll).not.toHaveBeenCalled();
    });

    it("runs indexing pipeline after clearing", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const command: CLICommand = {
        type: "parse",
        config: { sourcePath: "./src", language: "typescript", verbose: false, refresh: true },
      };

      await executeCLI(command);

      expect(pipeline.runIndexingPipeline).toHaveBeenCalledTimes(1);
    });

    it("provides user feedback when refresh begins in verbose mode", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const command: CLICommand = {
        type: "parse",
        config: { sourcePath: "./src", language: "typescript", verbose: true, refresh: true },
      };

      await executeCLI(command);

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Refresh flag enabled"));
    });

    it("displays clearing statistics in output", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const command: CLICommand = {
        type: "parse",
        config: { sourcePath: "./src", language: "typescript", verbose: false, refresh: true },
      };

      await executeCLI(command);

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Clearing Statistics:"));
    });

    it("updates spinner message when refresh is enabled", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const mockOra = vi.mocked(ora);
      const command: CLICommand = {
        type: "parse",
        config: { sourcePath: "./src", language: "typescript", verbose: false, refresh: true },
      };

      await executeCLI(command);

      expect(mockOra).toHaveBeenCalledWith(expect.stringContaining("Clearing existing data"));
    });

    it("does not display clearing statistics when refresh is false", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const command: CLICommand = {
        type: "parse",
        config: { sourcePath: "./src", language: "typescript", verbose: false, refresh: false },
      };

      await executeCLI(command);

      const calls = consoleErrorSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes("Clearing Statistics:"))).toBe(false);
    });

    it("closes adapter even when pipeline throws", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(pipeline.runIndexingPipeline).mockRejectedValueOnce(new Error("Pipeline failed"));

      const command: CLICommand = {
        type: "parse",
        config: { sourcePath: "./src", language: "typescript", verbose: false },
      };

      await expect(executeCLI(command)).rejects.toThrow("Pipeline failed");
      expect(mockAdapter.close).toHaveBeenCalled();
    });
  });
});
