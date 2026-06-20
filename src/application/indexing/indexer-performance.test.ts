/**
 * Indexer performance smoke / benchmark harness (Phase A).
 *
 * This is NOT a strict perf gate — it is a fast, deterministic harness that
 * exercises the real Phase 2 parser and the full {@link runIndexingPipeline}
 * against an in-memory fixture, then asserts the {@link IndexingMetrics}
 * snapshot is populated and internally consistent. Timings are logged via
 * console.error so a human can read a manual baseline.
 *
 * Run with: npx vitest run src/application/indexing/indexer-performance.test.ts
 *
 * Requirements: Phase A (instrument before optimizing).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  DatabaseAdapter,
  GraphAdapter,
  VectorAdapter,
  EmbeddingAdapter,
} from "../../core/ports/persistence.js";
import type { Embedding } from "../../core/domain.js";
import { walkFileTree } from "./structure/index.js";
import {
  extractAllSymbols,
  type ParsePool,
  type ParsePoolFactory,
} from "./parsing/index.js";
import { runParseTask } from "../../infrastructure/parsing/parse-worker.js";
import type {
  ParseTask,
  ParseTaskResult,
} from "../../infrastructure/parsing/parse-worker-protocol.js";
import type { WorkerPoolRunResult } from "../../platform/utils/worker-pool.js";
import { runIndexingPipeline } from "./pipeline.js";
import { createMetricsCollector, formatMetrics } from "./metrics.js";
import Parser from "tree-sitter";

// ─── In-memory fixture ────────────────────────────────────────────────────────

/** A few small TypeScript files with functions, classes, calls, and imports. */
const FIXTURE_FILES: Record<string, string> = {
  "a.ts": `
export function greet(name: string): string {
  return formatGreeting(name);
}

function formatGreeting(name: string): string {
  return "hello " + name;
}
`,
  "b.ts": `
import { greet } from "./a.js";

export class Greeter {
  greetAll(names: string[]): string[] {
    return names.map((n) => greet(n));
  }
}
`,
  "c.ts": `
export interface Shape {
  area(): number;
}

export class Circle implements Shape {
  constructor(private radius: number) {}
  area(): number {
    return Math.PI * this.radius * this.radius;
  }
}
`,
};

// ─── Fake adapters (counting, in-memory, dependency-free) ──────────────────────

function makeFakeGraphAdapter(): GraphAdapter {
  return {
    createNode: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue(undefined),
    queryNodes: vi.fn().mockResolvedValue([]),
    queryRelationships: vi.fn().mockResolvedValue([]),
    deleteNodesByLabel: vi.fn().mockResolvedValue(0),
    deleteRelationshipsByType: vi.fn().mockResolvedValue(0),
    runCypher: vi.fn().mockResolvedValue([]),
    runCypherWrite: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFakeVectorAdapter(): VectorAdapter {
  return {
    createTables: vi.fn().mockResolvedValue(undefined),
    indexSymbol: vi.fn().mockResolvedValue(undefined),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn().mockResolvedValue(0),
  };
}

function makeFakeEmbeddingAdapter(enabled: boolean): EmbeddingAdapter {
  const stub: Embedding = { vector: [0.1, 0.2, 0.3], dimensions: 3 };
  return {
    isEnabled: vi.fn().mockReturnValue(enabled),
    embedText: vi.fn().mockResolvedValue(enabled ? stub : null),
    getDimensions: vi.fn().mockReturnValue(3),
  };
}

function makeFakeAdapter(embeddingsEnabled: boolean): {
  adapter: DatabaseAdapter;
  graph: GraphAdapter;
  vector: VectorAdapter;
} {
  const graph = makeFakeGraphAdapter();
  const vector = makeFakeVectorAdapter();
  const embedding = makeFakeEmbeddingAdapter(embeddingsEnabled);
  const adapter: DatabaseAdapter = {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getGraphAdapter: vi.fn().mockReturnValue(graph),
    getVectorAdapter: vi.fn().mockReturnValue(vector),
    getEmbeddingAdapter: vi.fn().mockReturnValue(embedding),
  };
  return { adapter, graph, vector };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("indexer performance harness — metrics collector", () => {
  it("times a phase, records counts, and formats a summary", async () => {
    const m = createMetricsCollector();

    const value = await m.time("parsing", async () => {
      // Trivial CPU work so elapsed is non-zero on a monotonic clock.
      let acc = 0;
      for (let i = 0; i < 10_000; i++) acc += i;
      return acc;
    });
    expect(value).toBeGreaterThan(0);

    m.set("filesScanned", 3);
    m.set("symbolCount", 7);
    m.incr("graphNodeWrites", 7);
    m.incr("graphEdgeWrites");

    const snapshot = m.finalize();
    expect(snapshot.phases.parsing).toBeGreaterThanOrEqual(0);
    expect(snapshot.totalMs).toBeGreaterThanOrEqual(snapshot.phases.parsing);
    expect(snapshot.filesScanned).toBe(3);
    expect(snapshot.symbolCount).toBe(7);
    expect(snapshot.graphNodeWrites).toBe(7);
    expect(snapshot.graphEdgeWrites).toBe(1);

    const summary = formatMetrics(snapshot);
    expect(summary).toContain("Indexing metrics");
    expect(summary).toContain("parsing");
  });

  it("defaults batch/split/oversized counters to zero and renders the summary line", () => {
    const m = createMetricsCollector();
    const snapshot = m.finalize();
    expect(snapshot.nodeBatchCount).toBe(0);
    expect(snapshot.relationshipBatchCount).toBe(0);
    expect(snapshot.vectorBatchCount).toBe(0);
    expect(snapshot.adaptiveSplitCount).toBe(0);
    expect(snapshot.oversizedRowCount).toBe(0);

    const summary = formatMetrics(snapshot);
    expect(summary).toContain("batches:");
    expect(summary).toContain("0 node, 0 rel, 0 vector (0 splits, 0 oversized)");
  });

  it("renders accumulated batch/split/oversized counts in the summary line", () => {
    const m = createMetricsCollector();
    m.incr("nodeBatchCount", 3);
    m.incr("relationshipBatchCount", 2);
    m.incr("vectorBatchCount");
    m.incr("adaptiveSplitCount", 4);
    m.incr("oversizedRowCount", 1);

    const summary = formatMetrics(m.finalize());
    expect(summary).toContain("3 node, 2 rel, 1 vector (4 splits, 1 oversized)");
  });

  // ── B3: peak-RSS metric ──
  it("peakRssBytes is a monotonic high-water >= every per-phase RSS, and renders", () => {
    const m = createMetricsCollector();

    // Drive a few phases through startPhase/endPhase + time so RSS is sampled at
    // their boundaries. The exact byte values are environment-dependent, so the
    // assertions are invariants, not magnitudes.
    m.startPhase("structure");
    m.endPhase("structure");
    m.startPhase("parsing");
    // Allocate something during the parsing phase so any high-water shift is
    // attributed there, then sample explicitly.
    const ballast: number[] = new Array(50_000).fill(1);
    m.sampleMemory("parsing");
    expect(ballast.length).toBe(50_000); // keep `ballast` live across the sample
    m.endPhase("parsing");
    void m.time("persist", async () => undefined);

    const snapshot = m.finalize();

    // Global peak is positive (rss is always > 0) and is the monotonic maximum
    // across ALL per-phase high-waters.
    expect(snapshot.peakRssBytes).toBeGreaterThan(0);
    for (const phase of [
      "structure", "parsing", "resolution", "clustering", "processes", "search", "persist",
    ] as const) {
      expect(snapshot.peakRssBytes).toBeGreaterThanOrEqual(snapshot.phaseRssBytes[phase]);
    }
    // At least one phase that ran recorded a non-zero high-water (it was sampled
    // at a boundary); phases that never ran stay 0.
    const maxPhaseRss = Math.max(
      ...(["structure", "parsing", "resolution", "clustering", "processes", "search", "persist"] as const)
        .map((p) => snapshot.phaseRssBytes[p]),
    );
    expect(maxPhaseRss).toBeGreaterThan(0);
    expect(snapshot.peakRssBytes).toBe(
      Math.max(snapshot.peakRssBytes, maxPhaseRss),
    );

    const summary = formatMetrics(snapshot);
    expect(summary).toContain("memory:");
    expect(summary).toContain("peak RSS");
  });

  it("phases that never ran keep a zero RSS high-water", () => {
    const m = createMetricsCollector();
    m.startPhase("structure");
    m.endPhase("structure");
    const snapshot = m.finalize();
    // resolution never ran → its high-water stays 0, but the global peak is set.
    expect(snapshot.phaseRssBytes.resolution).toBe(0);
    expect(snapshot.peakRssBytes).toBeGreaterThan(0);
  });
});

describe("indexer performance harness — Phase 2 fixture", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "typocop-perf-"));
    for (const [name, content] of Object.entries(FIXTURE_FILES)) {
      await fs.writeFile(path.join(tmpDir, name), content, "utf8");
    }
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("extractAllSymbols produces symbols from a multi-file fixture", async () => {
    const fileNodes = await walkFileTree(tmpDir);
    expect(fileNodes.length).toBe(Object.keys(FIXTURE_FILES).length);

    const start = performance.now();
    const { symbols, skippedFiles } = await extractAllSymbols(fileNodes, tmpDir);
    const elapsedMs = performance.now() - start;

    console.error(
      `[perf] extractAllSymbols: ${fileNodes.length} files, ` +
        `${symbols.length} symbols, ${skippedFiles} skipped, ${elapsedMs.toFixed(1)}ms`,
    );

    expect(symbols.length).toBeGreaterThan(0);
    expect(skippedFiles).toBe(0);
    // IDs must be unique.
    const ids = symbols.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("runIndexingPipeline populates a consistent metrics snapshot", async () => {
    const fileNodes = await walkFileTree(tmpDir);
    const { adapter } = makeFakeAdapter(true);

    const result = await runIndexingPipeline({
      sourcePath: tmpDir,
      language: "typescript",
      verbose: false,
      adapter,
    });

    const m = result.metrics;
    console.error(formatMetrics(m));

    // All phase timings present and non-negative.
    for (const phase of ["structure", "parsing", "resolution", "clustering", "processes", "search", "persist"] as const) {
      expect(m.phases[phase]).toBeGreaterThanOrEqual(0);
    }
    expect(m.totalMs).toBeGreaterThan(0);

    // Counts are non-negative and consistent with the result object.
    expect(m.filesScanned).toBe(fileNodes.length);
    expect(m.filesParsed + m.skippedFiles).toBe(m.filesScanned);
    expect(m.symbolCount).toBe(result.symbols.length);
    expect(m.relationshipCount).toBe(result.relationships.length);
    expect(m.clusterCount).toBe(result.clusters.length);
    expect(m.processCount).toBe(result.processes.length);
    expect(m.externalDependencyCount).toBe(result.externalDependencyCount);
    expect(m.embeddingCount).toBe(result.embeddingCount);

    // Write counts match what the pipeline emitted.
    expect(m.graphNodeWrites).toBe(
      m.symbolCount + m.clusterCount + m.processCount + m.externalDependencyCount,
    );
    expect(m.vectorWrites).toBe(m.embeddingCount);
    expect(m.graphEdgeWrites).toBeGreaterThanOrEqual(0);

    // B3: a real run populates a positive peak-RSS high-water that dominates
    // every per-phase high-water (monotonic invariant), and is rendered.
    expect(m.peakRssBytes).toBeGreaterThan(0);
    for (const phase of ["structure", "parsing", "resolution", "clustering", "processes", "search", "persist"] as const) {
      expect(m.peakRssBytes).toBeGreaterThanOrEqual(m.phaseRssBytes[phase]);
    }
    expect(formatMetrics(m)).toContain("peak RSS");
  });

  // FAST, always-on smoke for the parallel (worker-pool) code path (B4). The
  // shipped product spawns real `worker_threads` whose entry is the compiled
  // `parse-worker.js` — unloadable under a plain `vitest run`. So we inject an
  // IN-PROCESS pool that drives the SAME `runParseTask` logic the real worker
  // uses, with `workerThreshold: 1` forcing `extractAllSymbols` down its
  // worker-pool branch. CI thus exercises the parallel dispatch/slot/flatten tail
  // on every run without the heavy `bench:parse` sweep, and asserts it stays
  // byte-identical to the serial in-process path.
  it("exercises the worker-pool branch on a small fixture (byte-identical to serial)", async () => {
    const fileNodes = await walkFileTree(tmpDir);

    const inProcessPoolFactory: ParsePoolFactory = (_size: number): ParsePool => {
      const parsers = new Map<string, Parser>();
      return {
        async run(
          tasks: readonly ParseTask[],
          onSettled?: (index: number) => void,
        ): Promise<WorkerPoolRunResult<ParseTaskResult>> {
          const results: (ParseTaskResult | null)[] = new Array(tasks.length).fill(null);
          // Settle in reverse to prove completion order never leaks into output.
          for (let pos = tasks.length - 1; pos >= 0; pos--) {
            results[pos] = await runParseTask(tasks[pos], parsers);
            onSettled?.(tasks[pos].index);
          }
          return { results, breakerTripped: false, failedIndices: [] };
        },
        async destroy() {},
      };
    };

    const serial = await extractAllSymbols(fileNodes, tmpDir, { useWorkerThreads: false });
    const pooled = await extractAllSymbols(fileNodes, tmpDir, {
      workerThreshold: 1,
      poolFactory: inProcessPoolFactory,
    });

    expect(pooled.symbols.length).toBeGreaterThan(0);
    expect(JSON.stringify(pooled)).toBe(JSON.stringify(serial));
  });
});
