/**
 * D5 — coordinated rename PLAN tests (preview-only).
 *
 * Uses a query-aware mock GraphAdapter that answers the shapes buildRenamePlan
 * issues:
 *   - exact resolve:        n.id = $val OR n.name = $val [AND n.filePath = $filePath]
 *   - reference sites:      (r)-[:CALLS|IMPORTS|REFERENCES]->(t) WHERE t.id = $val
 *   - suggestions/CONTAINS: handled by the shared resolver path.
 *
 * Asserts: def + N references → N+1 high-confidence edits with correct lines;
 * ambiguous name resolves via filePath; the plan is ALWAYS preview:true; and
 * NO write path (runCypherWrite) is reachable.
 */
import { describe, it, expect, vi } from "vitest";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import { buildRenamePlan } from "./rename-plan.js";

interface DefNode {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
}
interface RefSite {
  refId: string;
  filePath: string;
  startLine: number;
}

/**
 * Build a mock graph. `defs` are candidate definitions; an exact query returns
 * the first def matching (name/id) [and filePath when provided]. `refs` maps a
 * target id → its incoming reference sites.
 */
function makeGraph(opts: {
  defs: DefNode[];
  refs?: Record<string, RefSite[]>;
  runCypherWrite?: () => Promise<void>;
}): GraphAdapter {
  const refs = opts.refs ?? {};

  function nodeRow(d: DefNode) {
    return {
      n: {
        labels: ["Symbol"],
        properties: {
          id: d.id,
          name: d.name,
          kind: "function",
          filePath: d.filePath,
          startLine: String(d.startLine),
          startColumn: "0",
          endLine: String(d.startLine + 5),
          endColumn: "0",
          visibility: "public",
        },
      },
    };
  }

  const runCypher = async <T,>(query: string, paramsArg?: Record<string, unknown>): Promise<T[]> => {
    const params = paramsArg ?? {};
    // Reference-site query.
    if (query.includes("[:CALLS|IMPORTS|REFERENCES]")) {
      const list = refs[params.val as string] ?? [];
      return list.map((r) => ({
        refId: r.refId,
        filePath: r.filePath,
        startLine: String(r.startLine),
      })) as unknown as T[];
    }
    // Exact / file-scoped resolution.
    if (query.includes("n.id = $val OR n.name = $val")) {
      const matches = opts.defs.filter(
        (d) => d.id === params.val || d.name === params.val,
      );
      const scoped = params.filePath
        ? matches.filter((d) => d.filePath === params.filePath)
        : matches;
      const first = scoped[0];
      return (first ? [nodeRow(first)] : []) as unknown as T[];
    }
    // CONTAINS fuzzy (file-scoped or global).
    if (query.includes("n.name CONTAINS $val")) {
      const matches = opts.defs.filter((d) => d.name.includes(params.val as string));
      const scoped = params.filePath
        ? matches.filter((d) => d.filePath === params.filePath)
        : matches;
      const first = scoped[0];
      return (first ? [nodeRow(first)] : []) as unknown as T[];
    }
    // Suggestions for not_found.
    if (query.includes("RETURN DISTINCT n.name AS name")) {
      return opts.defs.map((d) => ({ name: d.name })) as unknown as T[];
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
    runCypherWrite: (opts.runCypherWrite ?? (async () => {})) as GraphAdapter["runCypherWrite"],
  };
}

describe("buildRenamePlan", () => {
  it("produces N+1 high-confidence edits (def + N references) with correct lines", async () => {
    const graph = makeGraph({
      defs: [{ id: "s1", name: "getUser", filePath: "/repo/user.ts", startLine: 10 }],
      refs: {
        s1: [
          { refId: "r1", filePath: "/repo/a.ts", startLine: 3 },
          { refId: "r2", filePath: "/repo/b.ts", startLine: 7 },
        ],
      },
    });

    const plan = await buildRenamePlan("getUser", "fetchUser", graph);

    expect(plan.resolution.kind).toBe("exact");
    expect(plan.highConfidenceCount).toBe(3); // 1 def + 2 refs
    expect(plan.edits).toHaveLength(3);

    const def = plan.edits[0];
    expect(def.kind).toBe("definition");
    expect(def.filePath).toBe("/repo/user.ts");
    expect(def.line).toBe(10);
    expect(def.confidence).toBe("high");

    const refLines = plan.edits.slice(1).map((e) => ({ file: e.filePath, line: e.line, kind: e.kind }));
    expect(refLines).toEqual([
      { file: "/repo/a.ts", line: 3, kind: "reference" },
      { file: "/repo/b.ts", line: 7, kind: "reference" },
    ]);
    expect(plan.edits.every((e) => e.confidence === "high")).toBe(true);
    expect(plan.edits.every((e) => e.oldName === "getUser" && e.newName === "fetchUser")).toBe(true);
  });

  it("emits exactly one word-boundary low-confidence regex descriptor", async () => {
    const graph = makeGraph({
      defs: [{ id: "s1", name: "doThing", filePath: "/repo/x.ts", startLine: 1 }],
    });
    const plan = await buildRenamePlan("doThing", "doStuff", graph);
    expect(plan.lowConfidenceCount).toBe(1);
    expect(plan.lowConfidence.confidence).toBe("low");
    expect(plan.lowConfidence.pattern).toBe("\\bdoThing\\b");
    expect(plan.lowConfidence.flags).toBe("g");
    // The descriptor actually matches whole-word occurrences and not substrings.
    const re = new RegExp(plan.lowConfidence.pattern, plan.lowConfidence.flags);
    expect("call doThing() here".match(re)).toHaveLength(1);
    expect("doThingExtra".match(re)).toBeNull();
  });

  it("disambiguates an ambiguous name via filePath", async () => {
    const graph = makeGraph({
      defs: [
        { id: "a", name: "save", filePath: "/repo/user.ts", startLine: 5 },
        { id: "b", name: "save", filePath: "/repo/order.ts", startLine: 8 },
      ],
      refs: {
        b: [{ refId: "rb", filePath: "/repo/checkout.ts", startLine: 2 }],
      },
    });

    const plan = await buildRenamePlan("save", "persist", graph, "/repo/order.ts");
    expect(plan.resolution.kind).toBe("exact");
    // Resolved to the order.ts definition, not user.ts.
    expect(plan.edits[0].filePath).toBe("/repo/order.ts");
    expect(plan.edits[0].line).toBe(8);
    // And picked up order.ts's references.
    expect(plan.edits.map((e) => e.filePath)).toEqual(["/repo/order.ts", "/repo/checkout.ts"]);
  });

  it("is ALWAYS preview:true — even when the symbol is not found", async () => {
    const found = makeGraph({
      defs: [{ id: "s1", name: "getUser", filePath: "/repo/user.ts", startLine: 10 }],
    });
    const notFound = makeGraph({ defs: [] });

    const planFound = await buildRenamePlan("getUser", "fetchUser", found);
    const planMissing = await buildRenamePlan("nope", "stillNope", notFound);

    expect(planFound.preview).toBe(true);
    expect(planMissing.preview).toBe(true);
    expect(planMissing.resolution.kind).toBe("not_found");
    expect(planMissing.edits).toHaveLength(0);
    expect(planMissing.highConfidenceCount).toBe(0);
    expect(planMissing.lowConfidenceCount).toBe(1);
  });

  it("never reaches a write path (runCypherWrite is not called)", async () => {
    const writeSpy = vi.fn(async () => {});
    const graph = makeGraph({
      defs: [{ id: "s1", name: "getUser", filePath: "/repo/user.ts", startLine: 10 }],
      refs: { s1: [{ refId: "r1", filePath: "/repo/a.ts", startLine: 3 }] },
      runCypherWrite: writeSpy,
    });

    await buildRenamePlan("getUser", "fetchUser", graph);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
