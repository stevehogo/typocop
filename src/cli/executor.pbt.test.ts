/**
 * Property-based tests for the refresh parameter functionality.
 *
 * Properties covered:
 *   1. Refresh clears all graph data (Req 3.7, 5.2)
 *   2. Refresh clears all vector data (Req 3.7, 5.3)
 *   3. Refresh rebuilds complete graph (Req 5.4)
 *   4. Refresh rebuilds complete embeddings (Req 5.4)
 *   5. Non-refresh preserves data (Req 5.5)
 *
 * Strategy: Generate random source paths and language combinations, then verify
 * that refresh behavior correctly clears and rebuilds data while non-refresh
 * preserves existing data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";
import type { Driver, Session } from "neo4j-driver";
import type { Pool } from "pg";

// ─── Mock setup ───────────────────────────────────────────────────────────────

const mockClearGraphData = vi.fn();
const mockClearVectorData = vi.fn();
const mockRunIndexingPipeline = vi.fn();

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

vi.mock("../graph/connection.js", () => ({
  createDriver: vi.fn().mockImplementation(async () => ({
    session: vi.fn().mockReturnValue({
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../vector/connection.js", () => ({
  createPool: vi.fn().mockImplementation(async () => ({
    end: vi.fn().mockResolvedValue(undefined),
  })),
  initVectorStore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../graph/store.js", () => ({
  clearGraphData: mockClearGraphData,
}));

vi.mock("../vector/index-store.js", () => ({
  clearVectorData: mockClearVectorData,
}));

vi.mock("../indexer/pipeline.js", () => ({
  runIndexingPipeline: mockRunIndexingPipeline,
}));

vi.mock("../config/index.js", () => ({
  configurationManager: {
    initialize: vi.fn().mockResolvedValue(undefined),
    getPrefix: vi.fn().mockReturnValue("tpc_"),
  },
}));

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("Property-based tests: Refresh parameter functionality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});

    // Default mock implementations
    mockClearGraphData.mockResolvedValue({
      nodesDeleted: 0,
      relationshipsDeleted: 0,
    });
    mockClearVectorData.mockResolvedValue(0);
    mockRunIndexingPipeline.mockResolvedValue({
      symbols: [],
      relationships: [],
      clusters: [],
      processes: [],
      skippedFiles: 0,
      embeddingCount: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Property 1: Refresh clears all graph data ─────────────────────────────────
  // Validates: Requirements 3.7, 5.2

  it("Property 1: Refresh clears all graph data", async () => {
    const { executeCLI } = await import("./executor.js");
    const { CLICommand } = await import("./parser.js");

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          sourcePath: fc.string({ minLength: 1 }),
          language: fc.constantFrom("typescript", "javascript", "python"),
          verbose: fc.boolean(),
          nodeCount: fc.integer({ min: 0, max: 1000 }),
          relCount: fc.integer({ min: 0, max: 1000 }),
        }),
        async (input) => {
          vi.clearAllMocks();

          // Setup: mock clearing to return the counts
          mockClearGraphData.mockResolvedValue({
            nodesDeleted: input.nodeCount,
            relationshipsDeleted: input.relCount,
          });

          mockRunIndexingPipeline.mockResolvedValue({
            symbols: [{ id: "sym1" }],
            relationships: [{ id: "rel1" }],
            clusters: [],
            processes: [],
            skippedFiles: 0,
            embeddingCount: 0,
          });

          const command: any = {
            type: "parse",
            config: {
              sourcePath: input.sourcePath,
              language: input.language,
              verbose: input.verbose,
              refresh: true, // Enable refresh
            },
          };

          await executeCLI(command);

          // Assert: clearGraphData must be called exactly once when refresh is true
          expect(mockClearGraphData).toHaveBeenCalledTimes(1);

          // Assert: clearGraphData must be called before indexing pipeline
          const clearGraphCallOrder = mockClearGraphData.mock.invocationCallOrder[0];
          const pipelineCallOrder = mockRunIndexingPipeline.mock.invocationCallOrder[0];
          return clearGraphCallOrder < pipelineCallOrder;
        }
      ),
      { numRuns: 50 }
    );
  });

  // ─── Property 2: Refresh clears all vector data ────────────────────────────────
  // Validates: Requirements 3.7, 5.3

  it("Property 2: Refresh clears all vector data", async () => {
    const { executeCLI } = await import("./executor.js");

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          sourcePath: fc.string({ minLength: 1 }),
          language: fc.constantFrom("typescript", "javascript", "python"),
          verbose: fc.boolean(),
          embeddingCount: fc.integer({ min: 0, max: 1000 }),
        }),
        async (input) => {
          vi.clearAllMocks();

          // Setup: mock clearing to return the embedding count
          mockClearVectorData.mockResolvedValue(input.embeddingCount);

          mockRunIndexingPipeline.mockResolvedValue({
            symbols: [{ id: "sym1" }],
            relationships: [],
            clusters: [],
            processes: [],
            skippedFiles: 0,
            embeddingCount: 10,
          });

          const command: any = {
            type: "parse",
            config: {
              sourcePath: input.sourcePath,
              language: input.language,
              verbose: input.verbose,
              refresh: true, // Enable refresh
            },
          };

          await executeCLI(command);

          // Assert: clearVectorData must be called exactly once when refresh is true
          expect(mockClearVectorData).toHaveBeenCalledTimes(1);

          // Assert: clearVectorData must be called before indexing pipeline
          const clearVectorCallOrder = mockClearVectorData.mock.invocationCallOrder[0];
          const pipelineCallOrder = mockRunIndexingPipeline.mock.invocationCallOrder[0];
          return clearVectorCallOrder < pipelineCallOrder;
        }
      ),
      { numRuns: 50 }
    );
  });

  // ─── Property 3: Refresh rebuilds complete graph ────────────────────────────────
  // Validates: Requirements 5.4

  it("Property 3: Refresh rebuilds complete graph", async () => {
    const { executeCLI } = await import("./executor.js");

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          sourcePath: fc.string({ minLength: 1 }),
          language: fc.constantFrom("typescript", "javascript", "python"),
          symbolCount: fc.integer({ min: 1, max: 100 }),
          relationshipCount: fc.integer({ min: 0, max: 100 }),
          clusterCount: fc.integer({ min: 0, max: 50 }),
          processCount: fc.integer({ min: 0, max: 50 }),
        }),
        async (input) => {
          vi.clearAllMocks();

          // Setup: mock pipeline to return graph data
          mockRunIndexingPipeline.mockResolvedValue({
            symbols: Array.from({ length: input.symbolCount }, (_, i) => ({
              id: `sym${i}`,
            })),
            relationships: Array.from({ length: input.relationshipCount }, (_, i) => ({
              id: `rel${i}`,
            })),
            clusters: Array.from({ length: input.clusterCount }, (_, i) => ({
              id: `cluster${i}`,
            })),
            processes: Array.from({ length: input.processCount }, (_, i) => ({
              id: `process${i}`,
            })),
            skippedFiles: 0,
            embeddingCount: 0,
          });

          const command: any = {
            type: "parse",
            config: {
              sourcePath: input.sourcePath,
              language: input.language,
              verbose: false,
              refresh: true,
            },
          };

          await executeCLI(command);

          // Assert: indexing pipeline must be called exactly once
          expect(mockRunIndexingPipeline).toHaveBeenCalledTimes(1);

          // Assert: pipeline is called after clearing
          const clearGraphCallOrder = mockClearGraphData.mock.invocationCallOrder[0];
          const pipelineCallOrder = mockRunIndexingPipeline.mock.invocationCallOrder[0];
          return clearGraphCallOrder < pipelineCallOrder;
        }
      ),
      { numRuns: 50 }
    );
  });

  // ─── Property 4: Refresh rebuilds complete embeddings ──────────────────────────
  // Validates: Requirements 5.4

  it("Property 4: Refresh rebuilds complete embeddings", async () => {
    const { executeCLI } = await import("./executor.js");

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          sourcePath: fc.string({ minLength: 1 }),
          language: fc.constantFrom("typescript", "javascript", "python"),
          embeddingCount: fc.integer({ min: 1, max: 100 }),
        }),
        async (input) => {
          vi.clearAllMocks();

          // Setup: mock pipeline to return embeddings
          mockRunIndexingPipeline.mockResolvedValue({
            symbols: [{ id: "sym1" }],
            relationships: [],
            clusters: [],
            processes: [],
            skippedFiles: 0,
            embeddingCount: input.embeddingCount,
          });

          const command: any = {
            type: "parse",
            config: {
              sourcePath: input.sourcePath,
              language: input.language,
              verbose: false,
              refresh: true,
            },
          };

          await executeCLI(command);

          // Assert: clearVectorData must be called before pipeline
          expect(mockClearVectorData).toHaveBeenCalledTimes(1);
          const clearVectorCallOrder = mockClearVectorData.mock.invocationCallOrder[0];
          const pipelineCallOrder = mockRunIndexingPipeline.mock.invocationCallOrder[0];

          // Assert: pipeline runs after clearing and produces embeddings
          expect(mockRunIndexingPipeline).toHaveBeenCalledTimes(1);
          return clearVectorCallOrder < pipelineCallOrder;
        }
      ),
      { numRuns: 50 }
    );
  });

  // ─── Property 5: Non-refresh preserves data ────────────────────────────────────
  // Validates: Requirements 5.5

  it("Property 5: Non-refresh preserves data", async () => {
    const { executeCLI } = await import("./executor.js");

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          sourcePath: fc.string({ minLength: 1 }),
          language: fc.constantFrom("typescript", "javascript", "python"),
          verbose: fc.boolean(),
        }),
        async (input) => {
          vi.clearAllMocks();

          mockRunIndexingPipeline.mockResolvedValue({
            symbols: [{ id: "sym1" }],
            relationships: [],
            clusters: [],
            processes: [],
            skippedFiles: 0,
            embeddingCount: 0,
          });

          const command: any = {
            type: "parse",
            config: {
              sourcePath: input.sourcePath,
              language: input.language,
              verbose: input.verbose,
              refresh: false, // Disable refresh (or omit it)
            },
          };

          await executeCLI(command);

          // Assert: clearGraphData must NOT be called when refresh is false
          expect(mockClearGraphData).not.toHaveBeenCalled();

          // Assert: clearVectorData must NOT be called when refresh is false
          expect(mockClearVectorData).not.toHaveBeenCalled();

          // Assert: indexing pipeline must still run
          expect(mockRunIndexingPipeline).toHaveBeenCalledTimes(1);

          return true;
        }
      ),
      { numRuns: 50 }
    );
  });
});
