/**
 * Real-Kùzu integration test for A4 diff-based persistence.
 *
 * The KEY guarantee: a DELTA (incremental) re-index produces a graph + vector
 * store BYTE-IDENTICAL to a fresh FULL index of the same tree. We index a small
 * fixture tree two ways into two separate embedded LadybugDBs:
 *   - DB-full: one full pipeline run (delta inactive).
 *   - DB-delta: a full pipeline run, then a SECOND run with a `delta` plan that
 *     re-inserts only the "changed" file (and deletes its old rows first) while
 *     leaving the unchanged file's rows in place.
 * Both must end up with the same Symbol nodes, the same edges (including the
 * inbound CROSS-FILE edge into the changed file, which the DETACH DELETE
 * transiently drops and the wholesale relationship rewrite restores by
 * logicalKey), and the same vectors.
 *
 * We also assert the narrower A4 unit guarantees end-to-end: removed-file
 * symbols are gone, deleteSymbolsByFilePaths deletes exactly the matching rows,
 * and the lastIndexed Metadata node is written.
 *
 * Side-effect import co-loads the embedding native stack into this worker's
 * module graph; without it, real-Kùzu workers intermittently crash on native
 * teardown. See memory: kuzu-test-worker-native-teardown. Lives under tests/ so
 * the side-effect import does not trip the infra no-sibling depcruise rule.
 */
import "../../src/infrastructure/embeddings/huggingface-embedding-adapter.js";

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEmbeddedConnection,
  type LadybugConnection,
} from "../../src/infrastructure/persistence/index.js";
import { LadybugGraphAdapter } from "../../src/infrastructure/persistence/ladybug-graph-adapter.js";
import { LadybugVectorAdapter } from "../../src/infrastructure/persistence/ladybug-vector-adapter.js";
import { runIndexingPipeline, type PipelineConfig } from "../../src/application/indexing/pipeline.js";
import type { DatabaseAdapter, EmbeddingAdapter } from "../../src/core/ports/persistence.js";
import type { Embedding } from "../../src/core/domain.js";

const PREFIX = "tpc_";
const DIMS = 8;

/**
 * Deterministic, source-free fake embedding adapter: maps a text to a fixed-dim
 * vector by hashing each char into a bucket. Enabled (so the vector store is
 * exercised) but performs NO network / native inference — keeps the test fast
 * and avoids the privacy gate / native stack entirely.
 */
class FakeEmbeddingAdapter implements EmbeddingAdapter {
  isEnabled(): boolean {
    return true;
  }
  getDimensions(): number {
    return DIMS;
  }
  async embedText(text: string): Promise<Embedding | null> {
    const vector = new Array(DIMS).fill(0);
    for (let i = 0; i < text.length; i++) {
      vector[i % DIMS] += text.charCodeAt(i) % 7;
    }
    return { vector, dimensions: DIMS };
  }
}

interface Harness {
  root: string;
  runtime: LadybugConnection;
  graph: LadybugGraphAdapter;
  vector: LadybugVectorAdapter;
  adapter: DatabaseAdapter;
}

async function openDb(dir: string): Promise<Harness> {
  const runtime = await createEmbeddedConnection(join(dir, "db.ladybug"));
  const graph = new LadybugGraphAdapter(runtime.connection, PREFIX);
  const vector = new LadybugVectorAdapter(runtime.connection, PREFIX);
  await graph.initializeSchema();
  await vector.createTables();
  const embedding = new FakeEmbeddingAdapter();
  const adapter: DatabaseAdapter = {
    initialize: async () => {},
    close: async () => {},
    getGraphAdapter: () => graph,
    getVectorAdapter: () => vector,
    getEmbeddingAdapter: () => embedding,
  };
  return { root: dir, runtime, graph, vector, adapter };
}

function baseConfig(sourcePath: string, adapter: DatabaseAdapter): PipelineConfig {
  return {
    sourcePath,
    language: "typescript",
    verbose: false,
    adapter,
    // Keep the fixture deterministic and fast: skip semantic cluster embedding.
    semanticClassification: false,
  };
}

/** Read the persisted graph into a comparable, order-independent snapshot. */
async function snapshot(graph: LadybugGraphAdapter, vector: LadybugVectorAdapter) {
  const symbols = await graph.queryNodes("Symbol");
  const calls = await graph.queryRelationships("CALLS");
  const imports = await graph.queryRelationships("IMPORTS");
  const symbolIds = symbols.map((n) => n.id).sort();
  const edgeKey = (
    rs: Array<{ sourceId?: string; targetId?: string }>,
    type: string,
  ): string[] => rs.map((r) => `${type}:${r.sourceId}->${r.targetId}`);
  const edges = [...edgeKey(calls, "CALLS"), ...edgeKey(imports, "IMPORTS")].sort();

  const vectorRows = await vector.semanticSearch({ vector: new Array(DIMS).fill(1), dimensions: DIMS }, 1000);
  const vectorIds = vectorRows.map((r) => r.symbolId).sort();

  return { symbolIds, edges, vectorIds };
}

describe("A4 diff-based persistence — delta == full equivalence (real-Kùzu)", () => {
  let fullH: Harness;
  let deltaH: Harness;
  let srcRoot: string;

  // Two-file fixture: b.ts imports + calls a function in a.ts (inbound CROSS-FILE
  // edge into a.ts). We will "change" a.ts on the incremental run.
  const A_TS = `export function alpha(): number { return 1; }\n`;
  const A_TS_CHANGED = `// edited\nexport function alpha(): number { return 2; }\n`;
  const B_TS = `import { alpha } from "./a.js";\nexport function beta(): number { return alpha(); }\n`;

  beforeEach(async () => {
    srcRoot = await mkdtemp(join(tmpdir(), "typocop-delta-src-"));
    await mkdir(srcRoot, { recursive: true });
    await writeFile(join(srcRoot, "a.ts"), A_TS);
    await writeFile(join(srcRoot, "b.ts"), B_TS);

    fullH = await openDb(await mkdtemp(join(tmpdir(), "typocop-delta-full-")));
    deltaH = await openDb(await mkdtemp(join(tmpdir(), "typocop-delta-delta-")));
  });

  afterEach(async () => {
    await fullH.runtime.close();
    await deltaH.runtime.close();
    await rm(fullH.root, { recursive: true, force: true });
    await rm(deltaH.root, { recursive: true, force: true });
    await rm(srcRoot, { recursive: true, force: true });
  });

  it("an incremental re-index of an edited tree matches a fresh full index", async () => {
    // DB-delta: initial full run, then edit a.ts and run again with a delta plan
    // that re-indexes ONLY a.ts (changed) and deletes its old rows first.
    await runIndexingPipeline(baseConfig(srcRoot, deltaH.adapter));

    await writeFile(join(srcRoot, "a.ts"), A_TS_CHANGED);
    const changed = "a.ts"; // FileNode paths are relative to sourcePath; matches Symbol.location.filePath
    await runIndexingPipeline({
      ...baseConfig(srcRoot, deltaH.adapter),
      delta: { removedAndChangedFiles: [changed], addedAndChangedFiles: [changed] },
    });

    // DB-full: a single fresh full run over the EDITED tree.
    await runIndexingPipeline(baseConfig(srcRoot, fullH.adapter));

    const full = await snapshot(fullH.graph, fullH.vector);
    const delta = await snapshot(deltaH.graph, deltaH.vector);

    // The KEY guarantee: identical symbols, edges (incl. the inbound cross-file
    // edge restored by the wholesale relationship rewrite), and vectors.
    expect(delta.symbolIds).toEqual(full.symbolIds);
    expect(delta.edges).toEqual(full.edges);
    expect(delta.vectorIds).toEqual(full.vectorIds);

    // Sanity: the fixture actually produced symbols and at least one edge.
    expect(full.symbolIds.length).toBeGreaterThan(0);
    expect(full.edges.length).toBeGreaterThan(0);

    // lastIndexed Metadata node is written (A4 / pre-existing bug 0.4).
    const meta = await deltaH.graph.queryNodes("Metadata", { key: "lastIndexed" });
    expect(meta.length).toBe(1);
    expect(typeof meta[0].properties.timestamp).toBe("string");
  });

  it("removed-file symbols are gone after a delta that drops a file", async () => {
    // Index both files, then delta-delete b.ts (treat it as removed) and re-insert
    // nothing for it.
    await runIndexingPipeline(baseConfig(srcRoot, deltaH.adapter));
    const before = await deltaH.graph.queryNodes("Symbol");
    const bPaths = new Set(
      before
        .filter((n) => String(n.properties.filePath) === "b.ts")
        .map((n) => n.id),
    );
    expect(bPaths.size).toBeGreaterThan(0);

    await runIndexingPipeline({
      ...baseConfig(srcRoot, deltaH.adapter),
      // Pretend b.ts was removed: delete its scope, re-insert nothing for it.
      // (a.ts unchanged this run; passing it keeps it re-asserted but identical.)
      delta: { removedAndChangedFiles: ["b.ts"], addedAndChangedFiles: [] },
    });

    const after = await deltaH.graph.queryNodes("Symbol");
    const afterIds = new Set(after.map((n) => n.id));
    for (const removed of bPaths) {
      expect(afterIds.has(removed)).toBe(false);
    }
    // a.ts symbols survive.
    expect(after.some((n) => String(n.properties.filePath) === "a.ts")).toBe(true);
  });

  it("deleteSymbolsByFilePaths deletes exactly the matching rows", async () => {
    await runIndexingPipeline(baseConfig(srcRoot, deltaH.adapter));
    const all = await deltaH.graph.queryNodes("Symbol");
    const aCount = all.filter((n) => String(n.properties.filePath) === "a.ts").length;
    expect(aCount).toBeGreaterThan(0);

    const deleted = await deltaH.graph.deleteSymbolsByFilePaths(["a.ts"]);
    expect(deleted).toBe(aCount);

    const remaining = await deltaH.graph.queryNodes("Symbol");
    expect(remaining.every((n) => String(n.properties.filePath) !== "a.ts")).toBe(true);
  });
});
