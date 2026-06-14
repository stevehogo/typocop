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
import { extractAllSymbols } from "./parsing/index.js";
import { runIndexingPipeline } from "./pipeline.js";
import { createMetricsCollector, formatMetrics } from "./metrics.js";

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

  it("includes LOC/s only when totalLines is known", () => {
    const known = createMetricsCollector();
    known.set("totalLines", 1000);
    // Drive totalMs > 0 by timing something.
    known.startPhase("structure");
    known.endPhase("structure");
    const withLines = formatMetrics(known.finalize());

    const unknown = createMetricsCollector();
    unknown.startPhase("structure");
    unknown.endPhase("structure");
    const withoutLines = formatMetrics(unknown.finalize());

    expect(withLines).toContain("LOC/s");
    expect(withoutLines).not.toContain("LOC/s");
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
  });
});
