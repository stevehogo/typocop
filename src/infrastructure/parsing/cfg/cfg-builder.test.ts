/**
 * Plan B — buildCfg over known TS/JS snippets with hand-derived block/edge
 * counts + edge kinds. Harness copied from the sibling complexity.test.ts.
 */
import { describe, it, expect } from "vitest";
import type Parser from "tree-sitter";
import { initParser } from "../init.js";
import { buildCfg, type Cfg, type CfgEdgeKind } from "./cfg-builder.js";
import type { Language } from "../../../core/domain.js";

const FN_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
]);

/** BFS for the first function-like node under root. */
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

/** Count edges of a given kind. */
const kindCount = (cfg: Cfg, kind: CfgEdgeKind): number =>
  cfg.edges.filter((e) => e.kind === kind).length;

describe("buildCfg — TypeScript", () => {
  it("straight-line: entry, one body block, exit; two seq edges", async () => {
    const cfg = await cfgOf("typescript", `function f(a: number) { const b = a + 1; return b; }`);
    // entry(0) -> body(2) -> exit(1). (return adds body->exit; end-of-body tail is null.)
    expect(cfg.blocks).toHaveLength(3);
    expect(cfg.blocks[cfg.entry]?.kind).toBe("entry");
    expect(cfg.blocks[cfg.exit]?.kind).toBe("exit");
    expect(cfg.edges).toHaveLength(2);
    expect(kindCount(cfg, "seq")).toBe(2);
    // both seq edges land on the synthetic blocks
    expect(cfg.edges.every((e) => e.kind === "seq")).toBe(true);
  });

  it("if/else: branch header with true+false arms, both merge to join", async () => {
    const src = `function f(x: number) {
      if (x > 0) { a(); } else { b(); }
      return 1;
    }`;
    const cfg = await cfgOf("typescript", src);
    // blocks: entry, exit, body(=branch header), join, then, else  => 6
    expect(cfg.blocks).toHaveLength(6);
    // header is a branch
    expect(cfg.blocks.some((b) => b.kind === "branch")).toBe(true);
    // edges: entry->header(seq), header->then(true), header->else(false),
    //        then->join(seq), else->join(seq), join->exit(seq) ... but `return`
    //        in join makes join->exit a seq. Total: 1 true, 1 false, 4 seq = 6
    expect(kindCount(cfg, "true")).toBe(1);
    expect(kindCount(cfg, "false")).toBe(1);
    expect(kindCount(cfg, "seq")).toBe(4);
    expect(cfg.edges).toHaveLength(6);
  });

  it("if (no else): false arm goes straight to join", async () => {
    const src = `function f(x: number) { if (x > 0) { a(); } return 1; }`;
    const cfg = await cfgOf("typescript", src);
    // blocks: entry, exit, body(branch header), join, then => 5
    expect(cfg.blocks).toHaveLength(5);
    expect(kindCount(cfg, "true")).toBe(1);
    expect(kindCount(cfg, "false")).toBe(1); // header -> join (false)
    // edges: entry->header(seq), header->then(true), header->join(false),
    //        then->join(seq), join->exit(seq) = 5
    expect(cfg.edges).toHaveLength(5);
    expect(kindCount(cfg, "seq")).toBe(3);
  });

  it("while loop: emits exactly one back edge to the loop header", async () => {
    const src = `function f(x: number) {
      while (x > 0) { x = x - 1; }
      return x;
    }`;
    const cfg = await cfgOf("typescript", src);
    // blocks: entry, exit, body(=loop header), join, loopBody => 5
    expect(cfg.blocks).toHaveLength(5);
    expect(cfg.blocks.some((b) => b.kind === "loop")).toBe(true);
    // the load-bearing assertion: exactly one back edge, body -> header
    expect(kindCount(cfg, "back")).toBe(1);
    const back = cfg.edges.find((e) => e.kind === "back")!;
    const header = cfg.blocks.find((b) => b.kind === "loop")!;
    expect(back.to).toBe(header.id);
    // header -> loopBody(true), header -> join(false)
    expect(kindCount(cfg, "true")).toBe(1);
    expect(kindCount(cfg, "false")).toBe(1);
    // entry->header(seq), loopBody->header(back), join->exit(seq) ...
    // edges: entry->header(seq), header->body(true), header->join(false),
    //        body->header(back), join->exit(seq) = 5
    expect(cfg.edges).toHaveLength(5);
  });

  it("switch with two cases + default: a true edge per case, no false (default present)", async () => {
    const src = `function f(x: number) {
      switch (x) { case 1: a(); break; case 2: b(); break; default: c(); }
      return 1;
    }`;
    const cfg = await cfgOf("typescript", src);
    expect(cfg.blocks.some((b) => b.kind === "switch")).toBe(true);
    // 3 case blocks (case1, case2, default) => 3 true edges from the switch header
    expect(kindCount(cfg, "true")).toBe(3);
    // default present ⇒ NO header->join false edge
    expect(kindCount(cfg, "false")).toBe(0);
  });

  it("switch without default: header has a false edge to join", async () => {
    const src = `function f(x: number) {
      switch (x) { case 1: a(); break; }
      return 1;
    }`;
    const cfg = await cfgOf("typescript", src);
    expect(kindCount(cfg, "true")).toBe(1);   // one case
    expect(kindCount(cfg, "false")).toBe(1);  // no default ⇒ skip-all path
  });

  it("try/catch: exceptional true edge into the catch block", async () => {
    const src = `function f() {
      try { a(); } catch (e) { b(); }
      return 1;
    }`;
    const cfg = await cfgOf("typescript", src);
    expect(cfg.blocks.some((b) => b.kind === "catch")).toBe(true);
    const catchB = cfg.blocks.find((b) => b.kind === "catch")!;
    // tryB -> catchB is the (exceptional) true edge
    expect(kindCount(cfg, "true")).toBe(1);
    expect(cfg.edges.find((e) => e.kind === "true")?.to).toBe(catchB.id);
    expect(kindCount(cfg, "back")).toBe(0);
  });

  it("early return: the returning block edges straight to exit", async () => {
    const src = `function f(x: number) {
      if (x < 0) { return -1; }
      return x;
    }`;
    const cfg = await cfgOf("typescript", src);
    // the then-block contains `return -1` ⇒ edges to exit; join also returns.
    const toExit = cfg.edges.filter((e) => e.to === cfg.exit);
    // two returns reach exit: the then-arm and the trailing `return x`
    expect(toExit).toHaveLength(2);
    expect(toExit.every((e) => e.kind === "seq")).toBe(true);
  });

  it("short-circuit/ternary in a plain statement marks its block `branch`", async () => {
    const src = `function f(a: boolean, b: boolean) { const x = a && b ? 1 : 2; foo(x); }`;
    const cfg = await cfgOf("typescript", src);
    // no control-flow statements ⇒ entry, body, exit; the body holds a decision expr
    expect(cfg.blocks).toHaveLength(3);
    const body = cfg.blocks.find((b) => b.kind === "branch");
    expect(body, "the body block should be tagged branch").toBeDefined();
  });
});

describe("buildCfg — JavaScript (same visitor)", () => {
  it("if/else in JS yields the same true/false arm shape", async () => {
    const src = `function f(x) { if (x) { a(); } else { b(); } return 1; }`;
    const cfg = await cfgOf("javascript", src);
    expect(kindCount(cfg, "true")).toBe(1);
    expect(kindCount(cfg, "false")).toBe(1);
    expect(cfg.blocks.some((b) => b.kind === "branch")).toBe(true);
  });

  it("JS while loop produces a back edge", async () => {
    const cfg = await cfgOf("javascript", `function f(x){ while(x){ x--; } return x; }`);
    expect(kindCount(cfg, "back")).toBe(1);
  });
});

describe("buildCfg — no visitor", () => {
  it("returns null for a language with no registered visitor (python)", async () => {
    const parser = await initParser("python");
    const tree = parser.parse(["def f(x):", "    if x:", "        return 1", "    return 0", ""].join("\n"));
    // find the python function_definition
    const queue: Parser.SyntaxNode[] = [tree.rootNode];
    let fn: Parser.SyntaxNode | null = null;
    while (queue.length > 0 && !fn) {
      const n = queue.shift()!;
      if (n.type === "function_definition") fn = n;
      for (let i = 0; i < n.namedChildCount; i++) {
        const c = n.namedChild(i);
        if (c) queue.push(c);
      }
    }
    expect(fn).not.toBeNull();
    expect(buildCfg(fn!, "python")).toBeNull();
  });
});
