/**
 * Wave 8 · T4/T5 — MCP wrapper tests for the data-touch enumeration tools:
 * route_map, what_reads_table, what_writes_table, what_publishes_to,
 * what_subscribes_to. Exercises the additive response blocks, the empty-state
 * degrade (no throw), and routing through executeTool by name. The querying-fn
 * behaviour is covered exhaustively in the application/querying/*.test.ts files;
 * here we assert the wrappers wire them through and shape the response.
 */
import { describe, it, expect, vi } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executeRouteMap } from "./route-map-tool.js";
import { executeTableTouch } from "./table-touch-tool.js";
import { executeEventChannel } from "./event-channel-tool.js";
import { executeTool } from "./tools.js";

/**
 * Mock graph whose runCypher returns fixture rows keyed by the distinctive edge
 * type in the query (so each tool's single query shape is answered).
 */
function makeGraph(rowsByEdge: Record<string, Record<string, unknown>[]>): GraphAdapter {
  const runCypher = vi.fn(async (query: string) => {
    for (const [edge, rows] of Object.entries(rowsByEdge)) {
      if (query.includes(edge)) return rows;
    }
    return [];
  });
  return {
    createNode: async () => {},
    createRelationship: async () => {},
    queryNodes: async () => [],
    queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0,
    deleteRelationshipsByType: async () => 0,
    runCypher: runCypher as unknown as GraphAdapter["runCypher"],
    runCypherWrite: async () => {},
  };
}

function makeAdapter(graph: GraphAdapter): DatabaseAdapter {
  return {
    initialize: vi.fn(),
    close: vi.fn(),
    getGraphAdapter: () => graph,
    getVectorAdapter: vi.fn(),
    getEmbeddingAdapter: vi.fn(),
  } as unknown as DatabaseAdapter;
}

function symNode(id: string, name: string) {
  return {
    n: {
      labels: ["Symbol"],
      properties: {
        id, name, kind: "function", filePath: `/repo/${id}.ts`,
        startLine: "1", startColumn: "0", endLine: "9", endColumn: "0", visibility: "public",
      },
    },
    confidence: "0.8",
    reason: "test-edge",
  };
}

describe("route_map tool", () => {
  it("happy path: returns the routeMap block + route symbols", async () => {
    const adapter = makeAdapter(makeGraph({
      HANDLES_ROUTE: [{
        endpointId: "apiendpoint:GET:/users", endpointName: "GET /users",
        handlerId: "h1", handlerName: "listUsers", handlerFilePath: "/repo/users.ts",
        confidence: "0.85", reason: "decorator-Get",
      }],
    }));
    const res = await executeRouteMap({}, adapter);
    expect(res.routeMap?.totalFound).toBe(1);
    expect(res.routeMap?.routes[0]).toMatchObject({ endpointName: "GET /users", handlerName: "listUsers" });
    expect(res.symbols[0].name).toBe("GET /users");
    expect(res.summary).toContain("1 route");
  });

  it("empty state: degrades to an empty result (no throw)", async () => {
    const adapter = makeAdapter(makeGraph({ HANDLES_ROUTE: [] }));
    const res = await executeRouteMap({}, adapter);
    expect(res.routeMap?.routes).toEqual([]);
    expect(res.symbols).toEqual([]);
    expect(res.summary).toMatch(/no routes found/i);
  });

  it("routes through executeTool by name", async () => {
    const adapter = makeAdapter(makeGraph({
      HANDLES_ROUTE: [{
        endpointId: "apiendpoint:GET:/x", endpointName: "GET /x",
        handlerId: "h", handlerName: "hx", handlerFilePath: "/repo/x.ts", confidence: null, reason: null,
      }],
    }));
    const res = await executeTool("route_map", {}, adapter);
    expect(res.routeMap?.routes[0].endpointName).toBe("GET /x");
  });
});

describe("what_reads_table / what_writes_table tools", () => {
  it("what_reads_table happy path: returns tableTouch + reader symbols", async () => {
    const adapter = makeAdapter(makeGraph({ READS_FROM_DB: [symNode("r1", "getUser")] }));
    const res = await executeTableTouch({ table: "Users" }, adapter, "reads");
    expect(res.tableTouch?.table).toBe("users");
    expect(res.tableTouch?.direction).toBe("reads");
    expect(res.symbols[0].name).toBe("getUser");
    expect(res.symbols[0].relationship).toBe("reads-table");
    expect(res.summary).toContain("read from table 'users'");
  });

  it("what_writes_table happy path: writes direction", async () => {
    const adapter = makeAdapter(makeGraph({ WRITES_TO_DB: [symNode("w1", "saveUser")] }));
    const res = await executeTableTouch({ table: "users" }, adapter, "writes");
    expect(res.tableTouch?.direction).toBe("writes");
    expect(res.symbols[0].relationship).toBe("writes-table");
  });

  it("empty state: degrades to an empty result (no throw)", async () => {
    const adapter = makeAdapter(makeGraph({ READS_FROM_DB: [] }));
    const res = await executeTableTouch({ table: "missing" }, adapter, "reads");
    expect(res.tableTouch?.touchers).toEqual([]);
    expect(res.symbols).toEqual([]);
    expect(res.summary).toMatch(/no code found that read from table 'missing'/i);
  });

  it("routes through executeTool by name (both tools)", async () => {
    const adapter = makeAdapter(makeGraph({
      READS_FROM_DB: [symNode("r1", "reader")],
      WRITES_TO_DB: [symNode("w1", "writer")],
    }));
    const reads = await executeTool("what_reads_table", { table: "users" }, adapter);
    expect(reads.tableTouch?.direction).toBe("reads");
    const writes = await executeTool("what_writes_table", { table: "users" }, adapter);
    expect(writes.tableTouch?.direction).toBe("writes");
  });
});

describe("what_publishes_to / what_subscribes_to tools", () => {
  it("what_publishes_to happy path", async () => {
    const adapter = makeAdapter(makeGraph({ PUBLISHES_EVENT: [symNode("p1", "emitOrder")] }));
    const res = await executeEventChannel({ topic: "order.created" }, adapter, "publishers");
    expect(res.eventChannel?.topic).toBe("order.created");
    expect(res.eventChannel?.direction).toBe("publishers");
    expect(res.symbols[0].name).toBe("emitOrder");
    expect(res.symbols[0].relationship).toBe("publishes-event");
  });

  it("what_subscribes_to happy path", async () => {
    const adapter = makeAdapter(makeGraph({ SUBSCRIBES_TO: [symNode("s1", "onOrder")] }));
    const res = await executeEventChannel({ topic: "order.created" }, adapter, "subscribers");
    expect(res.eventChannel?.direction).toBe("subscribers");
    expect(res.symbols[0].relationship).toBe("subscribes-event");
  });

  it("empty state: degrades to empty (events sub-flag off, no throw)", async () => {
    const adapter = makeAdapter(makeGraph({ SUBSCRIBES_TO: [] }));
    const res = await executeEventChannel({ topic: "order.created" }, adapter, "subscribers");
    expect(res.eventChannel?.participants).toEqual([]);
    expect(res.symbols).toEqual([]);
    expect(res.summary).toMatch(/event indexing is off by default/i);
  });

  it("routes through executeTool by name (both tools)", async () => {
    const adapter = makeAdapter(makeGraph({
      PUBLISHES_EVENT: [symNode("p1", "pub")],
      SUBSCRIBES_TO: [symNode("s1", "sub")],
    }));
    const pub = await executeTool("what_publishes_to", { topic: "t" }, adapter);
    expect(pub.eventChannel?.direction).toBe("publishers");
    const sub = await executeTool("what_subscribes_to", { topic: "t" }, adapter);
    expect(sub.eventChannel?.direction).toBe("subscribers");
  });
});
