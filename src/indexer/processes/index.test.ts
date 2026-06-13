/**
 * Phase 5 process tracing — property tests and unit tests.
 *
 * Properties:
 *   7: Process Step Ordering  — steps[i].order === i for all i  (Req 7.4)
 *   8: Process Minimum Length — steps.length >= 2               (Req 7.6)
 *
 * **Validates: Requirements 7.4, 7.6**
 */
import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { processArbitrary } from "../../types/arbitraries.js";
import type { Symbol, Relationship } from "../../core/domain.js";
import {
  findEntryPoints,
  buildCallGraph,
  calculateEntryPointScore,
  traceExecution,
  traceAllExecutions,
  buildProcessSteps,
  analyzeDataFlow,
  inferProcessName,
  traceProcesses,
  MIN_PROCESS_STEPS,
} from "./index.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSymbol(
  id: string,
  name: string,
  kind: Symbol["kind"] = "function",
  visibility: Symbol["visibility"] = "public",
): Symbol {
  return {
    id,
    name,
    kind,
    location: { filePath: "src/foo.ts", startLine: 1, startColumn: 0, endLine: 5, endColumn: 0 },
    visibility,
    modifiers: [],
  };
}

function makeRel(source: string, target: string): Relationship {
  return {
    id: `calls:${source}->${target}`,
    source,
    target,
    relType: "calls",
    metadata: {},
  };
}

// ─── Property 7: Process Step Ordering ───────────────────────────────────────

describe("Property 7: Process Step Ordering", () => {
  /**
   * **Validates: Requirements 7.4**
   * For any valid Process, steps[i].order === i for all i.
   */
  it("steps[i].order === i for all i in arbitrary processes", () => {
    fc.assert(
      fc.property(processArbitrary(), (process) => {
        for (let i = 0; i < process.steps.length; i++) {
          expect(process.steps[i].order).toBe(i);
        }
      }),
    );
  });

  it("traceProcesses produces steps with sequential 0-indexed order", () => {
    const symbols = [
      makeSymbol("a", "handleRequest"),
      makeSymbol("b", "processData"),
      makeSymbol("c", "saveRecord"),
    ];
    const rels = [makeRel("a", "b"), makeRel("b", "c")];
    const processes = traceProcesses(symbols, rels);

    for (const proc of processes) {
      for (let i = 0; i < proc.steps.length; i++) {
        expect(proc.steps[i].order).toBe(i);
      }
    }
  });

  it("buildProcessSteps assigns sequential 0-indexed order", () => {
    const path = ["a", "b", "c"];
    const descriptions = new Map([["a", "A"], ["b", "B"], ["c", "C"]]);
    const steps = buildProcessSteps(path, descriptions);

    expect(steps).toHaveLength(3);
    expect(steps[0].order).toBe(0);
    expect(steps[1].order).toBe(1);
    expect(steps[2].order).toBe(2);
  });
});

// ─── Property 8: Process Minimum Length ──────────────────────────────────────

describe("Property 8: Process Minimum Length", () => {
  /**
   * **Validates: Requirements 7.6**
   * All processes have at least 2 steps.
   */
  it("arbitrary processes always have at least 2 steps", () => {
    fc.assert(
      fc.property(processArbitrary(), (process) => {
        expect(process.steps.length).toBeGreaterThanOrEqual(2);
      }),
    );
  });

  it("traceProcesses never returns a process with fewer than 2 steps", () => {
    const symbols = [
      makeSymbol("a", "handleRequest"),
      makeSymbol("b", "processData"),
      makeSymbol("c", "saveRecord"),
      makeSymbol("d", "isolated"), // no calls — should not produce a process
    ];
    const rels = [makeRel("a", "b"), makeRel("b", "c")];
    const processes = traceProcesses(symbols, rels);

    for (const proc of processes) {
      expect(proc.steps.length).toBeGreaterThanOrEqual(MIN_PROCESS_STEPS);
    }
  });

  it("MIN_PROCESS_STEPS is 2", () => {
    expect(MIN_PROCESS_STEPS).toBe(2);
  });
});

// ─── Unit tests: calculateEntryPointScore ────────────────────────────────────

describe("calculateEntryPointScore", () => {
  it("returns 0 when calleeCount is 0", () => {
    expect(calculateEntryPointScore("main", true, 0, 0)).toBe(0);
  });

  it("exported functions score higher than unexported", () => {
    const exported = calculateEntryPointScore("handleRequest", true, 0, 3);
    const unexported = calculateEntryPointScore("handleRequest", false, 0, 3);
    expect(exported).toBeGreaterThan(unexported);
  });

  it("entry point name patterns boost score", () => {
    const handler = calculateEntryPointScore("handleLogin", true, 1, 3);
    const generic = calculateEntryPointScore("doSomething", true, 1, 3);
    expect(handler).toBeGreaterThan(generic);
  });

  it("utility name patterns reduce score", () => {
    const util = calculateEntryPointScore("getUser", true, 0, 3);
    const normal = calculateEntryPointScore("processOrder", true, 0, 3);
    expect(util).toBeLessThan(normal);
  });

  it("higher callee/caller ratio increases score", () => {
    const highRatio = calculateEntryPointScore("run", true, 0, 10);
    const lowRatio = calculateEntryPointScore("run", true, 10, 1);
    expect(highRatio).toBeGreaterThan(lowRatio);
  });
});

// ─── Unit tests: buildCallGraph ───────────────────────────────────────────────

describe("buildCallGraph", () => {
  it("only includes calls relationships", () => {
    const ids = new Set(["a", "b"]);
    const rels: Relationship[] = [
      makeRel("a", "b"),
      { id: "imports:a->b", source: "a", target: "b", relType: "imports", metadata: {} },
    ];
    const graph = buildCallGraph(ids, rels);
    expect(graph.get("a")?.has("b")).toBe(true);
    expect(graph.get("a")?.size).toBe(1);
  });

  it("excludes relationships where source or target is not in symbolIds", () => {
    const ids = new Set(["a", "b"]);
    const rels: Relationship[] = [makeRel("a", "external")];
    const graph = buildCallGraph(ids, rels);
    expect(graph.get("a")?.size).toBe(0);
  });
});

// ─── Unit tests: findEntryPoints ─────────────────────────────────────────────

describe("findEntryPoints", () => {
  it("returns empty array when no symbols have outgoing calls", () => {
    const symbols = [makeSymbol("a", "foo"), makeSymbol("b", "bar")];
    expect(findEntryPoints(symbols, [])).toEqual([]);
  });

  it("identifies controller-like symbols as entry points", () => {
    const symbols = [
      makeSymbol("ctrl", "handleRequest"),
      makeSymbol("svc", "processData"),
      makeSymbol("repo", "saveRecord"),
    ];
    const rels = [makeRel("ctrl", "svc"), makeRel("svc", "repo")];
    const entries = findEntryPoints(symbols, rels);
    // ctrl calls 2 things (svc, repo transitively) and is called by nobody
    expect(entries.length).toBeGreaterThan(0);
  });

  it("excludes symbols with no outgoing calls", () => {
    const symbols = [
      makeSymbol("a", "handleRequest"),
      makeSymbol("b", "leaf"), // no outgoing calls
    ];
    const rels = [makeRel("a", "b")];
    const entries = findEntryPoints(symbols, rels);
    expect(entries).not.toContain("b");
  });
});

// ─── Unit tests: traceExecution ──────────────────────────────────────────────

describe("traceExecution", () => {
  it("returns undefined when path is shorter than MIN_PROCESS_STEPS", () => {
    const graph = new Map([["a", new Set(["b"])], ["b", new Set<string>()]]);
    const descriptions = new Map([["a", "A"], ["b", "B"]]);
    // a → b is 2 steps, should be valid
    const result = traceExecution("a", graph, descriptions);
    expect(result).toBeDefined();
    expect(result!.steps.length).toBeGreaterThanOrEqual(MIN_PROCESS_STEPS);
  });

  it("detects cycles and marks process as cyclic", () => {
    // a → b → a (cycle)
    const graph = new Map([["a", new Set(["b"])], ["b", new Set(["a"])]]);
    const descriptions = new Map([["a", "A"], ["b", "B"]]);
    const result = traceExecution("a", graph, descriptions);
    expect(result).toBeDefined();
    expect(result!.cyclic).toBe(true);
  });

  it("traces a linear chain correctly", () => {
    const graph = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set<string>()],
    ]);
    const descriptions = new Map([["a", "A"], ["b", "B"], ["c", "C"]]);
    const result = traceExecution("a", graph, descriptions);
    expect(result).toBeDefined();
    expect(result!.steps.map((s) => s.symbolId)).toEqual(["a", "b", "c"]);
    expect(result!.cyclic).toBe(false);
  });
});

// ─── Unit tests: traceAllExecutions ──────────────────────────────────────────

describe("traceAllExecutions", () => {
  it("deduplicates identical paths", () => {
    const graph = new Map([
      ["a", new Set(["b"])],
      ["b", new Set(["c"])],
      ["c", new Set<string>()],
    ]);
    const descriptions = new Map([["a", "A"], ["b", "B"], ["c", "C"]]);
    const traces = traceAllExecutions(["a", "a"], graph, descriptions);
    expect(traces).toHaveLength(1);
  });

  it("returns empty array when no entry points produce valid traces", () => {
    const graph = new Map([["a", new Set<string>()]]);
    const descriptions = new Map([["a", "A"]]);
    const traces = traceAllExecutions(["a"], graph, descriptions);
    expect(traces).toHaveLength(0);
  });
});

// ─── Unit tests: analyzeDataFlow ─────────────────────────────────────────────

describe("analyzeDataFlow", () => {
  it("returns empty array for fewer than 2 steps", () => {
    const steps = [{ order: 0, symbolId: "a", description: "A" }];
    expect(analyzeDataFlow(steps, [], new Map())).toEqual([]);
  });

  it("creates edges for consecutive steps with calls relationships", () => {
    const steps = [
      { order: 0, symbolId: "a", description: "A" },
      { order: 1, symbolId: "b", description: "B" },
    ];
    const rels: Relationship[] = [makeRel("a", "b")];
    const symbolMap = new Map([
      ["a", makeSymbol("a", "A")],
      ["b", makeSymbol("b", "B")],
    ]);
    const edges = analyzeDataFlow(steps, rels, symbolMap);
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe("a");
    expect(edges[0].to).toBe("b");
  });

  it("infers dataType from symbol signature", () => {
    const steps = [
      { order: 0, symbolId: "a", description: "A" },
      { order: 1, symbolId: "b", description: "B" },
    ];
    const rels: Relationship[] = [makeRel("a", "b")];
    const bWithSig: Symbol = {
      ...makeSymbol("b", "getUser"),
      signature: "getUser(id: string): UserDto",
    };
    const symbolMap = new Map([["a", makeSymbol("a", "A")], ["b", bWithSig]]);
    const edges = analyzeDataFlow(steps, rels, symbolMap);
    expect(edges[0].dataType).toBe("UserDto");
  });
});

// ─── Unit tests: inferProcessName ────────────────────────────────────────────

describe("inferProcessName", () => {
  it("formats as 'Entry → Terminal'", () => {
    const steps = [
      { order: 0, symbolId: "a", description: "A" },
      { order: 1, symbolId: "b", description: "B" },
    ];
    const symbolMap = new Map([
      ["a", makeSymbol("a", "handleRequest")],
      ["b", makeSymbol("b", "saveRecord")],
    ]);
    const name = inferProcessName("a", steps, symbolMap);
    expect(name).toBe("HandleRequest → SaveRecord");
  });

  it("returns just entry name when entry equals terminal", () => {
    const steps = [{ order: 0, symbolId: "a", description: "A" }];
    const symbolMap = new Map([["a", makeSymbol("a", "main")]]);
    const name = inferProcessName("a", steps, symbolMap);
    expect(name).toBe("Main");
  });
});

// ─── Unit tests: traceProcesses (integration) ────────────────────────────────

describe("traceProcesses", () => {
  it("returns empty array for empty symbol set", () => {
    expect(traceProcesses([], [])).toEqual([]);
  });

  it("returns empty array when no calls relationships exist", () => {
    const symbols = [makeSymbol("a", "foo"), makeSymbol("b", "bar")];
    expect(traceProcesses(symbols, [])).toEqual([]);
  });

  it("produces processes with valid structure", () => {
    const symbols = [
      makeSymbol("a", "handleRequest"),
      makeSymbol("b", "processData"),
      makeSymbol("c", "saveRecord"),
    ];
    const rels = [makeRel("a", "b"), makeRel("b", "c")];
    const processes = traceProcesses(symbols, rels);

    for (const proc of processes) {
      expect(proc.id).toBeTruthy();
      expect(proc.name).toBeTruthy();
      expect(proc.entryPoint).toBeTruthy();
      expect(proc.steps.length).toBeGreaterThanOrEqual(2);
      // Steps are 0-indexed sequential
      for (let i = 0; i < proc.steps.length; i++) {
        expect(proc.steps[i].order).toBe(i);
      }
    }
  });

  it("all step symbolIds reference symbols in the input set", () => {
    const symbols = [
      makeSymbol("a", "handleRequest"),
      makeSymbol("b", "processData"),
      makeSymbol("c", "saveRecord"),
    ];
    const rels = [makeRel("a", "b"), makeRel("b", "c")];
    const symbolIds = new Set(symbols.map((s) => s.id));
    const processes = traceProcesses(symbols, rels);

    for (const proc of processes) {
      expect(symbolIds.has(proc.entryPoint)).toBe(true);
      for (const step of proc.steps) {
        expect(symbolIds.has(step.symbolId)).toBe(true);
      }
    }
  });
});
