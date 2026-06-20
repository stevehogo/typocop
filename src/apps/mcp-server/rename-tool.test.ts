/**
 * D5 — `rename` MCP tool tests. Exercises the response shape, the preview
 * invariant, the summary wording ("N high-confidence, M low-confidence,
 * PREVIEW only — no files changed"), routing through executeTool, validation
 * (require symbolName + newName, identifier-shape check), and that no write
 * path is reachable.
 */
import { describe, it, expect, vi } from "vitest";
import type { DatabaseAdapter, GraphAdapter } from "../../core/ports/persistence.js";
import { executeRenameTool } from "./rename-tool.js";
import { executeTool } from "./tools.js";
import { validateToolParams } from "./validation.js";
import { MCPValidationError } from "./types.js";

interface DefNode { id: string; name: string; filePath: string; startLine: number }
interface RefSite { refId: string; filePath: string; startLine: number }

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
          id: d.id, name: d.name, kind: "function",
          filePath: d.filePath, startLine: String(d.startLine),
          startColumn: "0", endLine: String(d.startLine + 5), endColumn: "0",
          visibility: "public",
        },
      },
    };
  }
  const runCypher = async <T,>(query: string, paramsArg?: Record<string, unknown>): Promise<T[]> => {
    const params = paramsArg ?? {};
    if (query.includes("[:CALLS|IMPORTS|REFERENCES]")) {
      const list = refs[params.val as string] ?? [];
      return list.map((r) => ({ refId: r.refId, filePath: r.filePath, startLine: String(r.startLine) })) as unknown as T[];
    }
    if (query.includes("n.id = $val OR n.name = $val")) {
      const matches = opts.defs.filter((d) => d.id === params.val || d.name === params.val);
      const scoped = params.filePath ? matches.filter((d) => d.filePath === params.filePath) : matches;
      const first = scoped[0];
      return (first ? [nodeRow(first)] : []) as unknown as T[];
    }
    if (query.includes("n.name CONTAINS $val")) {
      const matches = opts.defs.filter((d) => d.name.includes(params.val as string));
      const scoped = params.filePath ? matches.filter((d) => d.filePath === params.filePath) : matches;
      const first = scoped[0];
      return (first ? [nodeRow(first)] : []) as unknown as T[];
    }
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

function makeAdapter(graph: GraphAdapter): DatabaseAdapter {
  return {
    initialize: vi.fn(),
    close: vi.fn(),
    getGraphAdapter: () => graph,
    getVectorAdapter: vi.fn(),
    getEmbeddingAdapter: vi.fn(),
  } as unknown as DatabaseAdapter;
}

describe("executeRenameTool", () => {
  it("returns a preview plan with N+1 high-confidence edits and the right summary", async () => {
    const adapter = makeAdapter(makeGraph({
      defs: [{ id: "s1", name: "getUser", filePath: "/repo/user.ts", startLine: 10 }],
      refs: { s1: [{ refId: "r1", filePath: "/repo/a.ts", startLine: 3 }] },
    }));
    const res = await executeRenameTool({ symbolName: "getUser", newName: "fetchUser" }, adapter);

    expect(res.rename?.preview).toBe(true);
    expect(res.rename?.highConfidenceCount).toBe(2);
    expect(res.rename?.lowConfidenceCount).toBe(1);
    expect(res.rename?.edits).toHaveLength(2);
    expect(res.rename?.edits[0]).toMatchObject({ filePath: "/repo/user.ts", line: 10, kind: "definition", confidence: "high" });
    expect(res.summary).toContain("2 high-confidence, 1 low-confidence, PREVIEW only — no files changed");
    // Edits surface as response symbols for non-rename-aware consumers.
    expect(res.symbols).toHaveLength(2);
    expect(res.symbols[0]?.relationship).toBe("rename-definition");
  });

  it("stays preview:true and reports zero high-confidence on not_found", async () => {
    const adapter = makeAdapter(makeGraph({ defs: [] }));
    const res = await executeRenameTool({ symbolName: "ghost", newName: "phantom" }, adapter);
    expect(res.rename?.preview).toBe(true);
    expect(res.rename?.highConfidenceCount).toBe(0);
    expect(res.symbols).toHaveLength(0);
    expect(res.summary).toContain("0 high-confidence, 1 low-confidence, PREVIEW only — no files changed");
  });

  it("routes through executeTool and never reaches a write path", async () => {
    const writeSpy = vi.fn(async () => {});
    const adapter = makeAdapter(makeGraph({
      defs: [{ id: "s1", name: "getUser", filePath: "/repo/user.ts", startLine: 10 }],
      runCypherWrite: writeSpy,
    }));
    const res = await executeTool("rename", { symbolName: "getUser", newName: "fetchUser" }, adapter);
    expect(res.rename?.preview).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("validateToolParams: rename", () => {
  it("requires symbolName", () => {
    expect(() => validateToolParams("rename", { newName: "x" })).toThrow(MCPValidationError);
    expect(() => validateToolParams("rename", { newName: "x" })).toThrow("symbolName");
  });

  it("requires newName", () => {
    expect(() => validateToolParams("rename", { symbolName: "foo" })).toThrow(MCPValidationError);
    expect(() => validateToolParams("rename", { symbolName: "foo" })).toThrow("newName");
  });

  it("rejects a non-identifier newName", () => {
    expect(() => validateToolParams("rename", { symbolName: "foo", newName: "1bad" })).toThrow(/identifier/);
    expect(() => validateToolParams("rename", { symbolName: "foo", newName: "has space" })).toThrow(/identifier/);
    expect(() => validateToolParams("rename", { symbolName: "foo", newName: "with-dash" })).toThrow(/identifier/);
  });

  it("accepts a valid identifier newName (with optional filePath)", () => {
    expect(() => validateToolParams("rename", { symbolName: "foo", newName: "fetchUser" })).not.toThrow();
    expect(() => validateToolParams("rename", { symbolName: "foo", newName: "_private$1", filePath: "/a.ts" })).not.toThrow();
  });

  it("rejects a non-string filePath", () => {
    expect(() => validateToolParams("rename", { symbolName: "foo", newName: "bar", filePath: 5 })).toThrow(MCPValidationError);
  });
});
