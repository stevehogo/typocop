/**
 * Phase E — on-demand ingestion benchmark harness (NOT a CI gate).
 *
 * Establishes a BASELINE for the LadybugDB persist path before any Phase C cap
 * tuning. It drives the REAL {@link runIndexingPipeline} persist phase against a
 * synthetic, in-memory fixture that deliberately stresses the byte budget and
 * oversized/adaptive-split paths:
 *
 *   - MANY small symbols (BENCH_SYMBOLS, default 3000),
 *   - a fraction of them with LONG signatures/documentation (exercise the byte
 *     budget + oversized-row path),
 *   - DENSE relationships (CALLS fan-out per symbol),
 *   - clusters (CONTAINS edges) and processes (HAS_STEP edges),
 *   - embeddings enabled AND disabled.
 *
 * It uses an in-memory, COUNTING DatabaseAdapter — no real Kùzu, no network — so
 * the measured cost is the pipeline's grouping / chunking / split / metric work,
 * not engine I/O. The adapter implements BOTH the batch methods
 * (createNodes/createRelationships/indexSymbols) and the per-row fallbacks; the
 * batch path is what the pipeline takes.
 *
 * Output: total time, persist-phase time, rows/sec, and the Phase B batch
 * counters (node/rel/vector batches, adaptiveSplitCount, oversizedRowCount) via
 * {@link formatMetrics} plus a small rows/sec line. ALL output goes to
 * process.stderr only — never stdout, never source code or embedding text.
 *
 * GATING: the heavy body is registered with `describe.skip` UNLESS `RUN_BENCH`
 * is set in the environment, so a normal `npx vitest run src/application/indexing`
 * does NOT execute it (and it is never a hard performance gate). Run it on demand
 * via the `bench` package script (sets RUN_BENCH=1).
 */
import { describe, it, vi } from "vitest";
import type {
  Cluster,
  Embedding,
  ExternalDependencyNode,
  Process,
  Relationship,
  Symbol,
} from "../../core/domain.js";
import type {
  DatabaseAdapter,
  EmbeddingAdapter,
  GraphAdapter,
  VectorAdapter,
} from "../../core/ports/persistence.js";
import { formatMetrics, type IndexingMetrics } from "./metrics.js";
import type { VectorEntry } from "./persistence-helpers.js";

// ─── Synthetic fixture (counts/shape only — never real source) ──────────────────

interface Fixture {
  readonly fileNodes: ReadonlyArray<{ readonly path: string; readonly size: number }>;
  readonly symbols: Symbol[];
  readonly relationships: Relationship[];
  readonly extNodes: Map<string, ExternalDependencyNode>;
  readonly clusters: Cluster[];
  readonly processes: Process[];
  readonly embeddings: VectorEntry[];
}

/** Read a positive-integer env var, falling back to a default. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, received ${raw}`);
  }
  return parsed;
}

/**
 * Build a deterministic synthetic fixture. Scalable via:
 *   - BENCH_SYMBOLS         total symbol count (default 3000),
 *   - BENCH_FANOUT          CALLS edges per symbol (default 3),
 *   - BENCH_LONG_EVERY      every Nth symbol gets a long signature/doc (default 25),
 *   - BENCH_LONG_BYTES      length of the long text padding (default 4096),
 *   - BENCH_CLUSTER_SIZE    symbols per cluster (default 20),
 *   - BENCH_PROCESS_STEPS   steps per process (default 12),
 *   - BENCH_PROCESSES       number of processes (default symbolCount/200).
 *
 * The "long" symbols stress the byte budget; combined with a small
 * LADYBUG_GRPC_MAX_MESSAGE_BYTES (set by the harness) they also exercise the
 * oversized-row / adaptive-split paths.
 */
function buildFixture(): Fixture {
  const symbolCount = envInt("BENCH_SYMBOLS", 3000);
  const fanout = envInt("BENCH_FANOUT", 3);
  const longEvery = Math.max(1, envInt("BENCH_LONG_EVERY", 25));
  const longBytes = envInt("BENCH_LONG_BYTES", 4096);
  const clusterSize = Math.max(2, envInt("BENCH_CLUSTER_SIZE", 20));
  const processSteps = Math.max(2, envInt("BENCH_PROCESS_STEPS", 12));
  const processes = envInt("BENCH_PROCESSES", Math.max(1, Math.floor(symbolCount / 200)));

  const longText = "x".repeat(longBytes);

  const symbols: Symbol[] = [];
  for (let i = 0; i < symbolCount; i++) {
    const isLong = i % longEvery === 0;
    symbols.push({
      id: `sym-${i}`,
      logicalKey: `sym-${i}`,
      name: `symbol_${i}`,
      kind: "function",
      location: {
        filePath: `src/gen/file_${i % 256}.ts`,
        startLine: i,
        startColumn: 0,
        endLine: i + 5,
        endColumn: 0,
      },
      signature: isLong ? `fn(${longText})` : `fn_${i}()`,
      documentation: isLong ? longText : `doc ${i}`,
      visibility: "public",
      modifiers: [],
    });
  }

  // Dense CALLS relationships: each symbol calls the next `fanout` symbols.
  const relationships: Relationship[] = [];
  for (let i = 0; i < symbolCount; i++) {
    for (let f = 1; f <= fanout; f++) {
      const target = (i + f) % symbolCount;
      relationships.push({
        id: `rel-${i}-${f}`,
        source: `sym-${i}`,
        target: `sym-${target}`,
        relType: "calls",
        metadata: {},
      });
    }
  }

  // Clusters → CONTAINS edges.
  const clusters: Cluster[] = [];
  for (let start = 0; start < symbolCount; start += clusterSize) {
    const members: string[] = [];
    for (let j = start; j < Math.min(start + clusterSize, symbolCount); j++) {
      members.push(`sym-${j}`);
    }
    if (members.length < 2) continue;
    clusters.push({
      id: `cluster-${clusters.length}`,
      name: `cluster_${clusters.length}`,
      symbols: members,
      confidence: 0.9,
      category: "businessLogic",
    });
  }

  // Processes → HAS_STEP edges.
  const processList: Process[] = [];
  for (let p = 0; p < processes; p++) {
    const steps = Array.from({ length: processSteps }, (_, s) => ({
      order: s,
      symbolId: `sym-${(p * processSteps + s) % symbolCount}`,
      description: `step ${s}`,
    }));
    processList.push({
      id: `proc-${p}`,
      name: `process_${p}`,
      entryPoint: `sym-${(p * processSteps) % symbolCount}`,
      steps,
      dataFlow: [],
    });
  }

  // Vector entries (one per symbol) — small fixed-dim embeddings; metadata kept
  // tiny except the long-symbol fraction which pushes some vector rows oversized.
  const embeddings: VectorEntry[] = symbols.map((s, i) => {
    const metadata: Record<string, string> = { kind: s.kind };
    if (i % longEvery === 0) metadata.note = longText;
    return {
      symbolId: s.id,
      embedding: { vector: SHARED_VECTOR, dimensions: SHARED_VECTOR.length },
      metadata,
    };
  });

  const fileCount = Math.max(1, Math.ceil(symbolCount / 12));
  const fileNodes = Array.from({ length: fileCount }, (_, i) => ({
    path: `src/gen/file_${i}.ts`,
    size: 1000,
  }));

  return {
    fileNodes,
    symbols,
    relationships,
    extNodes: new Map(),
    clusters,
    processes: processList,
    embeddings,
  };
}

/** Small deterministic embedding vector reused across all entries. */
const SHARED_VECTOR: number[] = Array.from({ length: 16 }, (_, i) => (i % 7) / 7);

// ─── In-memory counting adapters (no real Kùzu, no network) ─────────────────────

interface CountingDb {
  readonly adapter: DatabaseAdapter;
  readonly counts: { nodes: number; relationships: number; vectors: number };
}

function makeCountingAdapter(embeddingsEnabled: boolean): CountingDb {
  const counts = { nodes: 0, relationships: 0, vectors: 0 };

  const graph: GraphAdapter = {
    createNode: async () => {
      counts.nodes += 1;
    },
    createRelationship: async () => {
      counts.relationships += 1;
    },
    createNodes: async (_label, nodes) => {
      counts.nodes += nodes.length;
    },
    createRelationships: async (_type, rels) => {
      counts.relationships += rels.length;
    },
    queryNodes: async () => [],
    queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0,
    deleteRelationshipsByType: async () => 0,
    runCypher: async () => [],
    runCypherWrite: async () => undefined,
  };

  const vector: VectorAdapter = {
    createTables: async () => undefined,
    indexSymbol: async () => {
      counts.vectors += 1;
    },
    indexSymbols: async (entries) => {
      counts.vectors += entries.length;
    },
    semanticSearch: async () => [],
    deleteAll: async () => 0,
  };

  // Deterministic fake embedding adapter: no network, fixed vector.
  const embedding: EmbeddingAdapter = {
    isEnabled: () => embeddingsEnabled,
    embedText: async () =>
      embeddingsEnabled
        ? ({ vector: SHARED_VECTOR, dimensions: SHARED_VECTOR.length } satisfies Embedding)
        : null,
    getDimensions: () => SHARED_VECTOR.length,
  };

  const adapter: DatabaseAdapter = {
    initialize: async () => undefined,
    close: async () => undefined,
    getGraphAdapter: () => graph,
    getVectorAdapter: () => vector,
    getEmbeddingAdapter: () => embedding,
  };

  return { adapter, counts };
}

// ─── Reporting (stderr only — never stdout, never source/embedding text) ─────────

function reportRun(label: string, metrics: IndexingMetrics): void {
  const persistMs = metrics.phases.persist;
  const persistRows =
    metrics.graphNodeWrites + metrics.graphEdgeWrites + metrics.vectorWrites;
  const rowsPerSec = persistMs > 0 ? (persistRows / persistMs) * 1000 : 0;

  process.stderr.write(`\n[bench] ===== ${label} =====\n`);
  process.stderr.write(formatMetrics(metrics) + "\n");
  process.stderr.write(
    `  rows/sec:     ${rowsPerSec.toFixed(0)} ` +
      `(${persistRows} persist rows in ${persistMs.toFixed(1)}ms persist; ` +
      `${metrics.totalMs.toFixed(1)}ms total)\n`,
  );
}

// ─── Harness body (gated) ───────────────────────────────────────────────────────

const BENCH_ENABLED = process.env.RUN_BENCH !== undefined && process.env.RUN_BENCH !== "";

// describe.skip by default so `npx vitest run` discovers but does NOT execute the
// heavy body. The `bench` package script sets RUN_BENCH=1 to enable it.
const runner = BENCH_ENABLED ? describe : describe.skip;

runner("ingestion benchmark (Phase E baseline)", () => {
  it("indexes a synthetic fixture with embeddings enabled and disabled", async () => {
    // Mock the inner phase modules so the benchmark feeds a deterministic
    // synthetic fixture straight into the persist path. This mirrors the
    // mock-adapter approach in pipeline.test.ts; only persistence is measured.
    const fixture = buildFixture();

    vi.doMock("./structure/index.js", () => ({
      walkFileTree: vi.fn().mockResolvedValue(fixture.fileNodes),
    }));
    vi.doMock("./parsing/index.js", () => ({
      extractAllSymbols: vi.fn().mockResolvedValue({
        symbols: fixture.symbols,
        hints: [],
        skippedFiles: 0,
      }),
    }));
    vi.doMock("./resolution/index.js", () => ({
      resolveReferences: vi.fn().mockReturnValue({
        relationships: fixture.relationships,
        extNodes: fixture.extNodes,
        dependsOnStats: { edgeCount: 0, maxFanOutPerImport: 0 },
      }),
    }));
    vi.doMock("./clustering/index.js", () => ({
      clusterSymbols: vi.fn().mockResolvedValue(fixture.clusters),
    }));
    vi.doMock("./processes/index.js", () => ({
      traceProcesses: vi.fn().mockReturnValue(fixture.processes),
    }));
    vi.doMock("./search/index.js", () => ({
      buildSearchIndex: vi.fn().mockImplementation(
        async (_symbols: unknown, _clusters: unknown, embedFn: unknown) => ({
          keywords: new Map(),
          symbolCount: fixture.symbols.length,
          // Embeddings are persisted only when the adapter is enabled (embedFn
          // is non-null). The disabled run returns no embeddings, just like the
          // real search phase skips embedding generation.
          embeddings: embedFn === null ? [] : fixture.embeddings,
          embeddingStats: {
            attempts: embedFn === null ? 0 : fixture.embeddings.length,
            successes: embedFn === null ? 0 : fixture.embeddings.length,
            failures: 0,
          },
        }),
      ),
    }));

    // Shrink the gRPC payload budget so the long-signature/doc rows trip the
    // oversized + adaptive-split paths the baseline is meant to surface.
    const prevBudget = process.env.LADYBUG_GRPC_MAX_MESSAGE_BYTES;
    process.env.LADYBUG_GRPC_MAX_MESSAGE_BYTES = String(
      envInt("BENCH_GRPC_MAX_BYTES", 64 * 1024),
    );

    // Import AFTER doMock so the mocked phase modules are wired in.
    const { runIndexingPipeline } = await import("./pipeline.js");

    process.stderr.write(
      `\n[bench] fixture: ${fixture.symbols.length} symbols, ` +
        `${fixture.relationships.length} relationships, ${fixture.clusters.length} clusters, ` +
        `${fixture.processes.length} processes, ${fixture.embeddings.length} embeddings; ` +
        `grpc budget=${process.env.LADYBUG_GRPC_MAX_MESSAGE_BYTES} bytes\n`,
    );

    try {
      for (const embeddingsEnabled of [true, false]) {
        const { adapter, counts } = makeCountingAdapter(embeddingsEnabled);
        const result = await runIndexingPipeline({
          sourcePath: "/bench/synthetic",
          language: "typescript",
          verbose: false,
          adapter,
        });
        reportRun(
          `embeddings ${embeddingsEnabled ? "ENABLED" : "DISABLED"}`,
          result.metrics,
        );
        process.stderr.write(
          `  adapter saw:  ${counts.nodes} nodes, ${counts.relationships} relationships, ` +
            `${counts.vectors} vectors\n`,
        );
      }
    } finally {
      if (prevBudget === undefined) {
        delete process.env.LADYBUG_GRPC_MAX_MESSAGE_BYTES;
      } else {
        process.env.LADYBUG_GRPC_MAX_MESSAGE_BYTES = prevBudget;
      }
      vi.doUnmock("./structure/index.js");
      vi.doUnmock("./parsing/index.js");
      vi.doUnmock("./resolution/index.js");
      vi.doUnmock("./clustering/index.js");
      vi.doUnmock("./processes/index.js");
      vi.doUnmock("./search/index.js");
    }
  });
});
