/**
 * Wave 8 · T4/T5 — real-Kùzu round-trip for the data-touch ENUMERATION query fns
 * (findRoutes / findTableTouchers / findEventParticipants). Seeds a real graph
 * with the synthetic-id conventions + all relevant edge types, then asserts each
 * query fn reads them back over the real adapter (prefix-injection + result
 * normalization included), and that an unfilled graph degrades to empty.
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
import { findRoutes } from "../../src/application/querying/route-map.js";
import { findTableTouchers } from "../../src/application/querying/table-touch.js";
import { findEventParticipants } from "../../src/application/querying/event-channel.js";

describe("Wave 8 data-touch enumeration tools — real-Kùzu round-trip", () => {
  let root: string;
  let runtime: LadybugConnection;
  let graph: LadybugGraphAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "typocop-w8-tools-int-"));
    runtime = await createEmbeddedConnection(join(root, "db.ladybug"));
    graph = new LadybugGraphAdapter(runtime.connection, "tpc_");
    await graph.initializeSchema();
  });

  afterEach(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  async function seed(): Promise<void> {
    await graph.createNodes("Symbol", [
      { id: "code:list", name: "listUsers", kind: "function", synthetic: "" },
      { id: "code:save", name: "saveUser", kind: "function", synthetic: "" },
      { id: "code:emit", name: "emitUserCreated", kind: "method", synthetic: "" },
      { id: "code:sub", name: "onUserCreated", kind: "method", synthetic: "" },
      { id: "dbmodel:user", name: "user", kind: "class", synthetic: "true" },
      { id: "apiendpoint:GET:/users", name: "GET /users", kind: "function", synthetic: "true" },
      { id: "eventchannel:user.created", name: "user.created", kind: "class", synthetic: "true" },
    ]);
    await graph.createRelationships("HANDLES_ROUTE", [
      { fromId: "code:list", toId: "apiendpoint:GET:/users", properties: { confidence: "0.85", reason: "decorator-Get" } },
    ]);
    await graph.createRelationships("READS_FROM_DB", [
      { fromId: "code:list", toId: "dbmodel:user", properties: { confidence: "0.7", reason: "prisma-findMany" } },
    ]);
    await graph.createRelationships("WRITES_TO_DB", [
      { fromId: "code:save", toId: "dbmodel:user", properties: { confidence: "0.7", reason: "prisma-create" } },
    ]);
    await graph.createRelationships("PUBLISHES_EVENT", [
      { fromId: "code:emit", toId: "eventchannel:user.created", properties: { confidence: "0.6", reason: "emit-call-heuristic" } },
    ]);
    // SUBSCRIBES_TO is INVERTED: channel is the source.
    await graph.createRelationships("SUBSCRIBES_TO", [
      { fromId: "eventchannel:user.created", toId: "code:sub", properties: { confidence: "0.85", reason: "decorator-OnEvent" } },
    ]);
  }

  it("findRoutes enumerates the seeded route", async () => {
    await seed();
    const result = await findRoutes(graph);
    expect(result.totalFound).toBe(1);
    expect(result.routes[0]).toMatchObject({
      endpointName: "GET /users",
      handlerName: "listUsers",
      confidence: 0.85,
      reason: "decorator-Get",
    });
  });

  it("findTableTouchers reads by dbmodel: id and by table name (reads + writes)", async () => {
    await seed();
    // Resolve by name (toLower(m.name) = 'user').
    const reads = await findTableTouchers(graph, "User", "reads");
    expect(reads.touchers.map((t) => t.symbol.name)).toEqual(["listUsers"]);
    expect(reads.touchers[0].confidence).toBe(0.7);

    const writes = await findTableTouchers(graph, "user", "writes");
    expect(writes.touchers.map((t) => t.symbol.name)).toEqual(["saveUser"]);
  });

  it("findEventParticipants lists publishers + subscribers (inversion handled)", async () => {
    await seed();
    const pubs = await findEventParticipants(graph, "user.created", "publishers");
    expect(pubs.participants.map((p) => p.symbol.name)).toEqual(["emitUserCreated"]);

    const subs = await findEventParticipants(graph, "user.created", "subscribers");
    expect(subs.participants.map((p) => p.symbol.name)).toEqual(["onUserCreated"]);
  });

  it("degrades to EMPTY on an unfilled graph (tables exist, no edges) — no throw", async () => {
    // No seed() — schema created, but no data-touch edges (TYPOCOP_DATA_TOUCH off case).
    const routes = await findRoutes(graph);
    expect(routes.routes).toHaveLength(0);

    const reads = await findTableTouchers(graph, "user", "reads");
    expect(reads.touchers).toHaveLength(0);

    const subs = await findEventParticipants(graph, "user.created", "subscribers");
    expect(subs.participants).toHaveLength(0);
  });
});
