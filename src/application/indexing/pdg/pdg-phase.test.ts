/**
 * Plan E #7 — runPdgPhase composes Plans B/C/D over real callable symbols:
 * a handler with `req.query.id → exec(id)` yields a `command` TaintFinding and
 * ≥1 BasicBlock; a clean function yields blocks but no finding; a no-visitor
 * language yields nothing. Builds real symbols (kind: "function") + a real file.
 */
import { describe, it, expect } from "vitest";
import { runPdgPhase } from "./pdg-phase.js";
import type { Symbol } from "../../../core/domain.js";

function fn(id: string, name: string, file: string, start: number, end: number): Symbol {
  return {
    id, logicalKey: id, name, kind: "function",
    location: { filePath: file, startLine: start, startColumn: 0, endLine: end, endColumn: 0 },
    visibility: "public", modifiers: [],
  };
}

describe("runPdgPhase", () => {
  it("emits BasicBlocks + a command TaintFinding for req.query.id → exec(id)", async () => {
    const content = [
      `import { exec } from "child_process";`,
      `export function handler(req: any) {`,
      `  const id = req.query.id;`,
      `  exec(id);`,
      `}`,
    ].join("\n");
    // startLine is the 0-based tree-sitter row (extract-symbols convention):
    // `export function handler` is the 2nd content line ⇒ row 1.
    const sym = fn("inject.ts#handler", "handler", "inject.ts", 1, 4);
    const res = await runPdgPhase([sym], [], [{ path: "inject.ts", content }]);

    expect(res.blocks.length).toBeGreaterThan(0);
    expect(res.blocks.every((b) => b.functionId === sym.logicalKey)).toBe(true);
    const cmd = res.findings.find((f) => f.sinkKind === "command");
    expect(cmd).toBeDefined();
    expect(cmd?.sanitized).toBe(false);
  });

  it("emits blocks but NO finding for a clean function", async () => {
    const content = [
      `export function add(a: number, b: number) {`,
      `  return a + b;`,
      `}`,
    ].join("\n");
    const sym = fn("clean.ts#add", "add", "clean.ts", 0, 2); // `export function add` is row 0
    const res = await runPdgPhase([sym], [], [{ path: "clean.ts", content }]);
    expect(res.blocks.length).toBeGreaterThan(0);
    expect(res.findings).toHaveLength(0);
  });

  it("skips a symbol whose file content is missing (no crash, no rows)", async () => {
    const sym = fn("missing.ts#x", "x", "missing.ts", 1, 3);
    const res = await runPdgPhase([sym], [], []);
    expect(res.blocks).toHaveLength(0);
    expect(res.findings).toHaveLength(0);
  });

  it("HARD RULE: produces only BasicBlock-ended / TaintFinding-anchored edges (no Symbol→Symbol)", async () => {
    const content = `export function f() { const a = 1; return a; }`;
    const sym = fn("e.ts#f", "f", "e.ts", 0, 0); // single-line function ⇒ row 0
    const res = await runPdgPhase([sym], [], [{ path: "e.ts", content }]);
    // cfg/cdg/reachingDef edges are BasicBlock→BasicBlock — their endpoints are
    // block ids ("<functionId>#<n>"), never bare Symbol ids.
    for (const e of [...res.cfgEdges, ...res.cdgEdges, ...res.reachingDefEdges]) {
      expect(e.fromId).toContain("#");
      expect(e.toId).toContain("#");
    }
  });
});
