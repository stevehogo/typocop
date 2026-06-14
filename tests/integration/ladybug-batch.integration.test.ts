/**
 * Real-Kùzu integration test for the Phase D batch write fast-paths.
 *
 * Round-trips createNodes + createRelationships + indexSymbols against a real
 * embedded LadybugDB and reads the data back via queryNodes / queryRelationships
 * / semanticSearch. The parameterized UNWIND patterns are independently proven;
 * this asserts the adapter wiring (prefixing, schema, metadata round-trip) holds
 * end-to-end.
 *
 * Side-effect import co-loads the embedding native stack into this worker's
 * module graph; without it, real-Kùzu workers intermittently crash on native
 * teardown. See memory: kuzu-test-worker-native-teardown. Lives under tests/
 * (not src/) so the side-effect import does not trip the infrastructure
 * no-sibling dependency-cruiser rule.
 */
import "../../src/infrastructure/embeddings/huggingface-embedding-adapter.js";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEmbeddedConnection,
  type LadybugConnection,
} from "../../src/infrastructure/persistence/index.js";
import { LadybugGraphAdapter } from "../../src/infrastructure/persistence/ladybug-graph-adapter.js";
import { LadybugVectorAdapter } from "../../src/infrastructure/persistence/ladybug-vector-adapter.js";

describe("Ladybug batch writes — real-Kùzu integration", () => {
  let root: string;
  let runtime: LadybugConnection;
  let graph: LadybugGraphAdapter;
  let vector: LadybugVectorAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "typocop-batch-int-"));
    runtime = await createEmbeddedConnection(join(root, "db.ladybug"));
    graph = new LadybugGraphAdapter(runtime.connection, "tpc_");
    vector = new LadybugVectorAdapter(runtime.connection, "tpc_");
    await graph.initializeSchema();
    await vector.createTables();
  });

  afterEach(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips createNodes + createRelationships + indexSymbols", async () => {
    await graph.createNodes("Symbol", [
      { id: "s1", name: "foo", kind: "function" },
      { id: "s2", name: "bar", kind: "class" },
    ]);
    await graph.createNodes("Process", [{ id: "p1", name: "boot" }]);

    await graph.createRelationships("CALLS", [{ fromId: "s1", toId: "s2" }]);
    await graph.createRelationships("HAS_STEP", [
      { fromId: "p1", toId: "s1", properties: { step_order: "0" } },
    ]);

    const symbols = await graph.queryNodes("Symbol");
    expect(symbols.map((n) => n.id).sort()).toEqual(["s1", "s2"]);

    const calls = await graph.queryRelationships("CALLS");
    expect(calls).toHaveLength(1);
    expect(calls[0].sourceId).toBe("s1");
    expect(calls[0].targetId).toBe("s2");

    const steps = await graph.queryRelationships("HAS_STEP");
    expect(steps).toHaveLength(1);
    expect(steps[0].properties.step_order).toBe("0");

    await vector.indexSymbols([
      {
        symbolId: "s1",
        embedding: { vector: [1, 0, 0], dimensions: 3 },
        metadata: { kind: "function" },
      },
    ]);

    const results = await vector.semanticSearch({ vector: [1, 0, 0], dimensions: 3 }, 10);
    expect(results).toHaveLength(1);
    expect(results[0].symbolId).toBe("s1");
    // Metadata parses identically to the per-row path.
    expect(results[0].metadata).toEqual({ kind: "function" });
  });
});
