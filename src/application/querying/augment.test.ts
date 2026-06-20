/**
 * D1 — augment engine tests.
 *
 * Covers the fail-silent contract (unknown pattern / thrown adapter / timeout
 * → "") and the happy path (a known symbol with callers produces a block).
 */
import { describe, it, expect, vi } from "vitest";
import type { GraphAdapter, GraphNode } from "../../core/ports/persistence.js";
import { augment } from "./augment.js";

function node(id: string, props: Record<string, string>): GraphNode {
  return { id, labels: ["Symbol"], properties: { id, ...props } };
}
function nodeRow(n: GraphNode) {
  return { n: { labels: n.labels, properties: n.properties } };
}

/**
 * A query-routing fake GraphAdapter. Routes each `runCypher` by the shape of the
 * query string so the augment engine + its delegate (executeContextRetrieval)
 * see coherent results without brittle call-order sequencing.
 */
function makeRoutingAdapter(opts: {
  candidates?: GraphNode[];
  target?: GraphNode;
  callers?: GraphNode[];
  callees?: GraphNode[];
  clusters?: GraphNode[];
  processes?: GraphNode[];
}): GraphAdapter {
  const {
    candidates = [],
    target,
    callers = [],
    callees = [],
    clusters = [],
    processes = [],
  } = opts;

  const runCypher = vi.fn(async (query: string) => {
    // augment's CONTAINS candidate scan
    if (/RETURN n\.id AS id, n\.name AS name/.test(query)) {
      return candidates.map((c) => ({ id: c.id, name: c.properties["name"] }));
    }
    // resolveSymbol exact match
    if (/WHERE n\.id = \$val OR n\.name = \$val/.test(query)) {
      return target ? [nodeRow(target)] : [];
    }
    // resolveSymbol fuzzy CONTAINS
    if (/WHERE n\.name CONTAINS \$val/.test(query)) {
      return target ? [nodeRow(target)] : [];
    }
    // suggestions
    if (/RETURN DISTINCT n\.name AS name/.test(query)) {
      return [];
    }
    // callers (findDependents): (n)-[CALLS]->(t)
    if (/\(n:Symbol\)-\[e:CALLS/.test(query)) {
      return callers.map(nodeRow);
    }
    // callees (findDependencies): (s)-[CALLS]->(n)
    if (/\(s:Symbol\)-\[e:CALLS/.test(query)) {
      return callees.map(nodeRow);
    }
    // external deps
    if (/:DEPENDS_ON/.test(query)) {
      return [];
    }
    // processes
    if (/\(p:Process\)-\[:HAS_STEP\]/.test(query)) {
      return processes.map((p) => ({ p: { labels: p.labels, properties: p.properties } }));
    }
    // process steps
    if (/HAS_STEP\]->\(s:Symbol\)\s+RETURN/.test(query)) {
      return [];
    }
    // clusters
    if (/\(c:Cluster\)-\[:CONTAINS\]/.test(query)) {
      return clusters.map((c) => ({ c: { labels: c.labels, properties: c.properties } }));
    }
    return [];
  });

  return {
    createNode: vi.fn(),
    createRelationship: vi.fn(),
    queryNodes: vi.fn(),
    queryRelationships: vi.fn(),
    deleteNodesByLabel: vi.fn(),
    deleteRelationshipsByType: vi.fn(),
    runCypher,
    runCypherWrite: vi.fn(),
  } as unknown as GraphAdapter;
}

describe("augment", () => {
  it('returns "" for a pattern that is too short to probe', async () => {
    const graph = makeRoutingAdapter({ candidates: [] });
    expect(await augment("ab", graph)).toBe("");
  });

  it('returns "" when no candidate symbols match (unknown pattern)', async () => {
    const graph = makeRoutingAdapter({ candidates: [] });
    expect(await augment("totallyUnknownThing", graph)).toBe("");
  });

  it('returns "" when the adapter throws (fail-silent)', async () => {
    const graph = {
      runCypher: vi.fn().mockRejectedValue(new Error("db exploded")),
    } as unknown as GraphAdapter;
    expect(await augment("someSymbol", graph)).toBe("");
  });

  it('returns "" when the query exceeds the timeout (fail-silent)', async () => {
    vi.useFakeTimers();
    try {
      const graph = {
        // Never resolves — the augment timeout must win the race.
        runCypher: vi.fn(() => new Promise(() => {})),
      } as unknown as GraphAdapter;
      const p = augment("someSymbol", graph);
      // Advance past AUGMENT_TIMEOUT_MS (2000ms) so the timeout sentinel fires.
      await vi.advanceTimersByTimeAsync(2_500);
      expect(await p).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns "" when a candidate resolves but has no graph context', async () => {
    const target = node("sym:getUser", {
      name: "getUser",
      kind: "function",
      filePath: "/src/user.ts",
      startLine: "1",
    });
    const graph = makeRoutingAdapter({ candidates: [target], target });
    expect(await augment("getUser", graph)).toBe("");
  });

  it("returns a block for a known symbol with callers/callees/cluster/flow", async () => {
    const target = node("sym:getUser", {
      name: "getUser",
      kind: "function",
      filePath: "/src/user.ts",
      startLine: "10",
    });
    const caller = node("sym:handleLogin", {
      name: "handleLogin",
      kind: "function",
      filePath: "/src/auth.ts",
      startLine: "5",
    });
    const callee = node("sym:queryDb", {
      name: "queryDb",
      kind: "function",
      filePath: "/src/db.ts",
      startLine: "20",
    });
    const cluster: GraphNode = {
      id: "cluster:auth",
      labels: ["Cluster"],
      properties: { id: "cluster:auth", name: "AuthCluster", confidence: "0.9", category: "auth" },
    };
    const process: GraphNode = {
      id: "proc:login",
      labels: ["Process"],
      properties: { id: "proc:login", name: "LoginFlow", entryPoint: "sym:handleLogin" },
    };
    const graph = makeRoutingAdapter({
      candidates: [target],
      target,
      callers: [caller],
      callees: [callee],
      clusters: [cluster],
      processes: [process],
    });

    const block = await augment("getUser", graph);
    expect(block).toContain("getUser");
    expect(block).toContain("called by: handleLogin");
    expect(block).toContain("calls: queryDb");
    expect(block).toContain("cluster: AuthCluster");
    expect(block).toContain("flows: LoginFlow");
    // No marker — the CLI adds [typocop], not the engine.
    expect(block).not.toContain("[typocop]");
  });
});
