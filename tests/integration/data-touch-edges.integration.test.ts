/**
 * Wave 5 — real-Kùzu persist→read round-trip for the 5 data-touch REL tables
 * (READS_FROM_DB / WRITES_TO_DB / HANDLES_ROUTE / PUBLISHES_EVENT / SUBSCRIBES_TO)
 * and the synthetic-Symbol node column.
 *
 * Asserts each new edge type (a) has its REL table, (b) round-trips its
 * `confidence`/`reason` STRING props through the allow-list, and (c) that the
 * synthetic node column persists + reads back.
 *
 * Side-effect import co-loads the embedding native stack into this worker's
 * module graph; without it real-Kùzu workers intermittently crash on native
 * teardown (see memory: kuzu-test-worker-native-teardown).
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

const DATA_TOUCH_RELS = [
  "READS_FROM_DB",
  "WRITES_TO_DB",
  "HANDLES_ROUTE",
  "PUBLISHES_EVENT",
  "SUBSCRIBES_TO",
] as const;

describe("Wave 5 data-touch edges — real-Kùzu persist round-trip", () => {
  let root: string;
  let runtime: LadybugConnection;
  let graph: LadybugGraphAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "typocop-data-touch-int-"));
    runtime = await createEmbeddedConnection(join(root, "db.ladybug"));
    graph = new LadybugGraphAdapter(runtime.connection, "tpc_");
    await graph.initializeSchema();
  });

  afterEach(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips all 5 data-touch edge types with confidence/reason props", async () => {
    // A real code symbol + a synthetic DB-model anchor + a synthetic endpoint +
    // a synthetic event channel — all on the single Symbol node table.
    await graph.createNodes("Symbol", [
      { id: "code:1", name: "listUsers", kind: "function", synthetic: "" },
      { id: "dbmodel:user", name: "user", kind: "class", synthetic: "true" },
      { id: "apiendpoint:GET:/users", name: "GET /users", kind: "function", synthetic: "true" },
      { id: "eventchannel:user.created", name: "user.created", kind: "class", synthetic: "true" },
    ]);

    await graph.createRelationships("READS_FROM_DB", [
      { fromId: "code:1", toId: "dbmodel:user", properties: { confidence: "0.7", reason: "db-read-findMany" } },
    ]);
    await graph.createRelationships("WRITES_TO_DB", [
      { fromId: "code:1", toId: "dbmodel:user", properties: { confidence: "0.7", reason: "db-write-save" } },
    ]);
    await graph.createRelationships("HANDLES_ROUTE", [
      { fromId: "code:1", toId: "apiendpoint:GET:/users", properties: { confidence: "0.85", reason: "decorator-Get" } },
    ]);
    await graph.createRelationships("PUBLISHES_EVENT", [
      { fromId: "code:1", toId: "eventchannel:user.created", properties: { confidence: "0.6", reason: "emit-call-heuristic" } },
    ]);
    await graph.createRelationships("SUBSCRIBES_TO", [
      { fromId: "eventchannel:user.created", toId: "code:1", properties: { confidence: "0.85", reason: "decorator-OnEvent" } },
    ]);

    const expectedProps: Record<string, { confidence: string; reason: string }> = {
      READS_FROM_DB: { confidence: "0.7", reason: "db-read-findMany" },
      WRITES_TO_DB: { confidence: "0.7", reason: "db-write-save" },
      HANDLES_ROUTE: { confidence: "0.85", reason: "decorator-Get" },
      PUBLISHES_EVENT: { confidence: "0.6", reason: "emit-call-heuristic" },
      SUBSCRIBES_TO: { confidence: "0.85", reason: "decorator-OnEvent" },
    };

    for (const type of DATA_TOUCH_RELS) {
      const rows = await graph.queryRelationships(type);
      expect(rows, `${type} should have exactly one edge`).toHaveLength(1);
      // confidence/reason survived the per-type allow-list + REL columns.
      expect(rows[0].properties.confidence).toBe(expectedProps[type].confidence);
      expect(rows[0].properties.reason).toBe(expectedProps[type].reason);
    }
  });

  it("persists + reads back the synthetic node column", async () => {
    await graph.createNodes("Symbol", [
      { id: "code:real", name: "foo", kind: "function", synthetic: "" },
      { id: "dbmodel:order", name: "order", kind: "class", synthetic: "true" },
    ]);
    const nodes = await graph.queryNodes("Symbol");
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("code:real")!.properties["synthetic"]).toBe("");
    expect(byId.get("dbmodel:order")!.properties["synthetic"]).toBe("true");
  });
});
