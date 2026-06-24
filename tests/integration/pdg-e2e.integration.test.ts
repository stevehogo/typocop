/**
 * Plan E #9 (LAST) — end-to-end `--pdg` proof + HARD-RULE equivalence, over a
 * REAL temp Kùzu DB. Indexes a tiny fixture and asserts:
 *   1. With --pdg, `explain` returns the command-injection finding.
 *   2. `impact_analysis` returns byte-identical results with vs without --pdg
 *      (the HARD RULE: PDG/taint edges never enter its (Symbol)-[]->(Symbol)
 *      traversal).
 *   3. Default-OFF: a no-flag run persists ZERO BasicBlock/TaintFinding nodes.
 *
 * Real-Kùzu harness mirrors tests/integration/diff-persistence.integration.test.ts
 * (createEmbeddedConnection + a deterministic FakeEmbeddingAdapter). The
 * side-effect import co-loads the embedding native stack into this worker so the
 * real-Kùzu adapter does not crash on native teardown (memory:
 * kuzu-test-worker-native-teardown).
 */
import "../../src/infrastructure/embeddings/huggingface-embedding-adapter.js";

import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
import { explainFindings } from "../../src/application/querying/explain.js";
import { executeImpactAnalysis } from "../../src/application/querying/impact-analysis.js";

const PREFIX = "tpc_";
const DIMS = 8;

class FakeEmbeddingAdapter implements EmbeddingAdapter {
  isEnabled(): boolean { return true; }
  getDimensions(): number { return DIMS; }
  async embedText(text: string): Promise<Embedding | null> {
    const vector = new Array(DIMS).fill(0);
    for (let i = 0; i < text.length; i++) vector[i % DIMS] += text.charCodeAt(i) % 7;
    return { vector, dimensions: DIMS };
  }
}

interface Harness {
  runtime: LadybugConnection;
  graph: LadybugGraphAdapter;
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
  return { runtime, graph, adapter };
}

function baseConfig(sourcePath: string, adapter: DatabaseAdapter, pdg: boolean): PipelineConfig {
  return {
    sourcePath,
    language: "typescript",
    verbose: false,
    adapter,
    semanticClassification: false, // deterministic + fast: skip cluster embedding
    ...(pdg ? { pdg: true } : {}),
  };
}

// A real command injection (req.query.cmd → exec) + a sanitized sibling (Number()).
const INJECT_TS = [
  `import { exec } from "child_process";`,
  ``,
  `export function runUserCommand(req: { query: Record<string, string> }): void {`,
  `  const cmd = req.query.cmd;`,
  `  exec(cmd);`,
  `}`,
  ``,
  `export function runSafeCommand(req: { query: Record<string, string> }): void {`,
  `  const raw = req.query.id;`,
  `  const id = Number(raw);`,
  `  exec(\`echo \${id}\`);`,
  `}`,
  ``,
].join("\n");

describe("Plan E #9 — PDG end-to-end (real-Kùzu)", () => {
  let srcRoot: string;
  const dbs: Harness[] = [];

  beforeEach(async () => {
    srcRoot = await mkdtemp(join(tmpdir(), "typocop-pdg-e2e-src-"));
    await writeFile(join(srcRoot, "inject.ts"), INJECT_TS);
  });

  afterEach(async () => {
    for (const h of dbs) await h.runtime.close();
    dbs.length = 0;
    await rm(srcRoot, { recursive: true, force: true });
  });

  async function freshDb(): Promise<Harness> {
    const h = await openDb(await mkdtemp(join(tmpdir(), "typocop-pdg-e2e-db-")));
    dbs.push(h);
    return h;
  }

  it("explain returns the command injection after a --pdg index", async () => {
    const h = await freshDb();
    await runIndexingPipeline(baseConfig(srcRoot, h.adapter, true));

    const res = await explainFindings(h.adapter.getGraphAdapter());
    const cmd = res.findings.find((f) => f.sinkKind === "command" && !f.sanitized);
    expect(cmd).toBeDefined();
    expect(res.summary).toMatch(/never auto-act/i);
  });

  it("impact_analysis is byte-identical with vs without --pdg (HARD RULE)", async () => {
    const withPdg = await freshDb();
    await runIndexingPipeline(baseConfig(srcRoot, withPdg.adapter, true));
    const without = await freshDb();
    await runIndexingPipeline(baseConfig(srcRoot, without.adapter, false));

    const a = await executeImpactAnalysis("runUserCommand", 100, withPdg.adapter.getGraphAdapter());
    const b = await executeImpactAnalysis("runUserCommand", 100, without.adapter.getGraphAdapter());
    expect(JSON.stringify(a.symbols)).toBe(JSON.stringify(b.symbols));
  });

  it("default (no --pdg) persists NO BasicBlock/TaintFinding nodes", async () => {
    const h = await freshDb();
    await runIndexingPipeline(baseConfig(srcRoot, h.adapter, false));
    const blocks = await h.adapter.getGraphAdapter().runCypher<{ c: number }>(`MATCH (b:BasicBlock) RETURN count(b) AS c`);
    const findings = await h.adapter.getGraphAdapter().runCypher<{ c: number }>(`MATCH (f:TaintFinding) RETURN count(f) AS c`);
    expect(Number(blocks?.[0]?.c ?? 0)).toBe(0);
    expect(Number(findings?.[0]?.c ?? 0)).toBe(0);
  });
});
