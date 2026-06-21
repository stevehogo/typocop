/**
 * Wave 5 (Task 7) — `trace_data_flow` rewired onto real data-touch edges.
 *
 * Asserts that the `model` layer is EDGE-RESOLVED (from an inbound
 * READS_FROM_DB/WRITES_TO_DB edge) rather than name-regex-guessed, and that an
 * edge-backed trace scores HIGHER confidence than the pre-wave regex ladder.
 *
 * The mock GraphAdapter answers the three query shapes `executeDataFlowTrace`
 * issues: the resolver's exact/fuzzy lookups, and the new data-flow trace query
 * (CALLS reach + OPTIONAL HANDLES_ROUTE / READS_FROM_DB|WRITES_TO_DB arms with
 * the coalesced edge confidence).
 */
import { describe, it, expect } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { executeDataFlowTrace } from "./data-flow-trace.js";

interface NodeRow {
  n: { labels: string[]; properties: Record<string, string> };
}

function node(id: string, name: string, extra: Record<string, string> = {}) {
  return {
    n: {
      labels: ["Symbol"],
      properties: { id, name, kind: "function", filePath: `/repo/${id}.ts`, visibility: "public", ...extra },
    },
  };
}

/**
 * Build a mock graph whose data-flow trace query returns `dependencyNodes` with
 * the supplied edge-resolved touch flags. `entryName` resolves as the entry node.
 */
function makeGraph(opts: {
  entryName: string;
  deps: { id: string; name: string; hasRoute?: boolean; hasDb?: boolean; edgeConfidence?: string | null }[];
}): GraphAdapter {
  const runCypher = async <T,>(query: string, params?: Record<string, unknown>): Promise<T[]> => {
    const val = params?.["val"] as string | undefined;
    // Resolver exact lookup.
    if (query.includes("WHERE n.id = $val OR n.name = $val") && query.includes("LIMIT 1")) {
      return (val === opts.entryName ? [node(opts.entryName, opts.entryName)] : []) as unknown as T[];
    }
    // Resolver fuzzy fallback.
    if (query.includes("n.name CONTAINS $val")) {
      return (opts.entryName.includes(val ?? "") ? [node(opts.entryName, opts.entryName)] : []) as unknown as T[];
    }
    // The Wave 5 data-flow trace query (CALLS reach + OPTIONAL touch arms).
    if (query.includes("HANDLES_ROUTE") && query.includes("READS_FROM_DB")) {
      return opts.deps.map((d) => ({
        ...node(d.id, d.name),
        hasRoute: d.hasRoute ?? false,
        hasDb: d.hasDb ?? false,
        edgeConfidence: d.edgeConfidence ?? null,
      })) as unknown as T[];
    }
    return [] as T[];
  };
  return {
    createNode: async () => {},
    createRelationship: async () => {},
    queryNodes: async () => [],
    queryRelationships: async () => [],
    deleteNodesByLabel: async () => 0,
    deleteRelationshipsByType: async () => 0,
    runCypher: runCypher as GraphAdapter["runCypher"],
    runCypherWrite: async () => {},
  } as unknown as GraphAdapter;
}

describe("trace_data_flow — edge-resolved layering (Task 7)", () => {
  it("classifies a node as `model` from an inbound READS_FROM_DB edge, NOT a name regex", async () => {
    // The data-access node's NAME ("users") would NOT match the model regex
    // (/model/i, /entity/i, /schema/i, /table/i) — so a `model` classification
    // can ONLY come from the edge, proving the rewire.
    const graph = makeGraph({
      entryName: "listUsersHandler",
      deps: [
        { id: "svc", name: "listUsersService" }, // service: no edge, no regex match → unknown/service
        { id: "users", name: "users", hasDb: true, edgeConfidence: "0.7" }, // model: ONLY via edge
      ],
    });

    const res = await executeDataFlowTrace("listUsersHandler", 50, graph);

    // The `users` node landed in the model layer (edge-resolved) and is in the path.
    expect(res.affectedFlows).toContain("model");
    expect(res.symbols.some((s) => s.name === "users")).toBe(true);
  });

  it("edge-backed traces score HIGHER confidence than the regex ladder fallback", async () => {
    // Edge-backed: a HANDLES_ROUTE api node + a READS_FROM_DB model node, both
    // with high edge confidence.
    const edgeGraph = makeGraph({
      entryName: "createOrder",
      deps: [
        { id: "ctrl", name: "createOrderController", hasRoute: true, edgeConfidence: "0.85" },
        { id: "orders", name: "orders", hasDb: true, edgeConfidence: "0.9" },
      ],
    });
    const edgeRes = await executeDataFlowTrace("createOrder", 50, edgeGraph);

    // No-edge baseline: same node names but NO touch edges → falls back to the
    // regex ladder (hardcoded confidence).
    const regexGraph = makeGraph({
      entryName: "createOrder",
      deps: [
        { id: "ctrl", name: "createOrderController" },
        { id: "orders", name: "ordersModel" }, // matches /model/i regex → model layer, but no edge
      ],
    });
    const regexRes = await executeDataFlowTrace("createOrder", 50, regexGraph);

    // The edge-backed confidence is strictly greater than the regex-only path.
    expect(edgeRes.confidence).toBeGreaterThan(regexRes.confidence);
    // And the edge path still resolves a model layer.
    expect(edgeRes.affectedFlows).toContain("model");
  });

  it("falls back to classifyLayer regex when a node has NO data-touch edge (graceful degradation)", async () => {
    // A repository node with no edge but a regex-matching name still classifies.
    const graph = makeGraph({
      entryName: "h",
      deps: [{ id: "repo", name: "OrderRepository" }],
    });
    const res = await executeDataFlowTrace("h", 50, graph);
    expect(res.affectedFlows).toContain("repository");
  });
});
