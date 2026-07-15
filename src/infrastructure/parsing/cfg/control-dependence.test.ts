/**
 * Plan C — computeControlDependence over real TS snippets via buildCfg.
 * Asserts: (1) an if/else's two arms are control-dependent on the predicate with
 * correct T/F sense + guard; (2) a while body is control-dependent on the loop
 * header. Harness mirrors the sibling cfg-builder.test.ts.
 */
import { describe, it, expect } from "vitest";
import type Parser from "tree-sitter";
import { initParser } from "../init.js";
import { buildCfg, type Cfg } from "./cfg-builder.js";
import { computeControlDependence, type CdgEdge } from "./control-dependence.js";
import type { Language } from "../../../core/domain.js";

const FN_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
]);

function findFn(root: Parser.SyntaxNode): Parser.SyntaxNode {
  const queue: Parser.SyntaxNode[] = [root];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (FN_TYPES.has(n.type)) return n;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) queue.push(c);
    }
  }
  throw new Error("no function node found");
}

async function cfgOf(language: Language, src: string): Promise<Cfg> {
  const parser = await initParser(language);
  const tree = parser.parse(src);
  const cfg = buildCfg(findFn(tree.rootNode), language);
  expect(cfg, `expected a CFG for ${language}`).not.toBeNull();
  return cfg!;
}

/** All CDG edges out of the controlling block `from`. */
const out = (cdg: readonly CdgEdge[], from: number): CdgEdge[] =>
  cdg.filter((e) => e.from === from);

describe("computeControlDependence — if/else", () => {
  it("both arms are control-dependent on the branch header with T/F sense + guard", async () => {
    const src = `function f(x: number) {
      if (x > 0) { a(); } else { b(); }
      return 1;
    }`;
    const cfg = await cfgOf("typescript", src);
    const cdg = computeControlDependence(cfg);

    // The branch header is the multi-successor block whose CFG edges are true/false.
    const header = cfg.blocks.find((b) => b.kind === "branch")!;
    expect(header).toBeDefined();

    // The then-arm (true target) and else-arm (false target) of the header.
    const trueTarget = cfg.edges.find((e) => e.from === header.id && e.kind === "true")!.to;
    const falseTarget = cfg.edges.find((e) => e.from === header.id && e.kind === "false")!.to;

    const fromHeader = out(cdg, header.id);
    // Both arms control-dependent on the header.
    const thenEdge = fromHeader.find((e) => e.to === trueTarget);
    const elseEdge = fromHeader.find((e) => e.to === falseTarget);
    expect(thenEdge, "then-arm control-dependent on header").toBeDefined();
    expect(elseEdge, "else-arm control-dependent on header").toBeDefined();
    expect(thenEdge!.branchSense).toBe("T");
    expect(elseEdge!.branchSense).toBe("F");
    // An if-branch is a data guard.
    expect(thenEdge!.guard).toBe(true);
    expect(elseEdge!.guard).toBe(true);

    // The join (post-dominator of the header) is NOT control-dependent on the header.
    // It is reached on every path, so no header->join CDG edge.
    const headerPostdomReached = fromHeader.some(
      (e) => e.to !== trueTarget && e.to !== falseTarget && e.branchSense === undefined,
    );
    expect(headerPostdomReached).toBe(false);
  });
});

describe("computeControlDependence — loop", () => {
  it("the while body is control-dependent on the loop header (sense T, guard false)", async () => {
    const src = `function f(x: number) {
      while (x > 0) { x = x - 1; }
      return x;
    }`;
    const cfg = await cfgOf("typescript", src);
    const cdg = computeControlDependence(cfg);

    const header = cfg.blocks.find((b) => b.kind === "loop")!;
    expect(header).toBeDefined();
    const bodyTarget = cfg.edges.find((e) => e.from === header.id && e.kind === "true")!.to;

    const bodyEdge = out(cdg, header.id).find((e) => e.to === bodyTarget);
    expect(bodyEdge, "loop body control-dependent on header").toBeDefined();
    expect(bodyEdge!.branchSense).toBe("T");
    // A loop header is iteration control, not a data guard.
    expect(bodyEdge!.guard).toBe(false);
  });
});

describe("computeControlDependence — straight line", () => {
  it("a function with no branches has no control-dependence edges", async () => {
    const cfg = await cfgOf("typescript", `function f(a: number) { const b = a + 1; return b; }`);
    expect(computeControlDependence(cfg)).toEqual([]);
  });
});

describe("computeControlDependence — robustness", () => {
  it("returns [] for an empty/degenerate CFG, never throws", () => {
    const empty: Cfg = { blocks: [], edges: [], entry: 0, exit: 0 };
    expect(computeControlDependence(empty)).toEqual([]);
  });
});
