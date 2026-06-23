/**
 * Plan D #6 — solveTaint flags req.query.id → child_process.exec as a `command`
 * TaintFinding; the same flow through a sanitizer/parameterizer is `sanitized`.
 * Builds a real Cfg via Plan B's buildCfg; supplies hand-written def→use edges
 * (the data Plan C computes at runtime) so the test is independent of Plan C.
 */
import { describe, it, expect } from "vitest";
import type Parser from "tree-sitter";
import { initParser } from "../../../infrastructure/parsing/init.js";
import { buildCfg, type Cfg } from "../../../infrastructure/parsing/cfg/cfg-builder.js";
import { getTaintSpec } from "../../../infrastructure/parsing/taint/source-sink-config.js";
import { buildImportProvenance } from "../../../infrastructure/parsing/taint/specs/typescript.js";
import { solveTaint, type DefUseEdge, type FunctionPdg } from "./solver.js";
import type { Relationship } from "../../../core/domain.js";

const FN_TYPES = new Set(["function_declaration", "method_definition", "arrow_function", "function_expression"]);
async function cfgOf(src: string): Promise<Cfg> {
  const parser = await initParser("typescript");
  const tree = parser.parse(src);
  const queue: Parser.SyntaxNode[] = [tree.rootNode];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (FN_TYPES.has(n.type)) {
      const cfg = buildCfg(n, "typescript");
      if (!cfg) throw new Error("no cfg");
      return cfg;
    }
    for (let i = 0; i < n.namedChildCount; i++) { const c = n.namedChild(i); if (c) queue.push(c); }
  }
  throw new Error("no function");
}

/** Connect every non-entry/exit block to every later block for `variable`
 * (a conservative def→use stand-in: the real Plan C edges are a subset, but the
 * solver only propagates a variable into a block that actually reads it). */
function fullDefUse(cfg: Cfg, variable: string): DefUseEdge[] {
  const ids = cfg.blocks.map((b) => b.id).filter((id) => id !== cfg.entry && id !== cfg.exit);
  const edges: DefUseEdge[] = [];
  for (const from of ids) for (const to of ids) if (from !== to) edges.push({ fromBlock: from, toBlock: to, variable });
  return edges;
}

const cpProv = buildImportProvenance([{ targetName: "child_process", namedBindings: [{ local: "exec", exported: "exec" }] }]);
const registry = getTaintSpec;
const NO_CALLS: Relationship[] = [];

describe("solveTaint — command injection (intra-proc)", () => {
  it("flags req.query.id flowing into exec(...) as a `command` finding", async () => {
    const cfg = await cfgOf(`
      function handler(req: any) {
        const id = req.query.id;
        exec(id);
      }
    `);
    const pdg: FunctionPdg = {
      symbolId: "handler", language: "typescript", cfg,
      defUse: fullDefUse(cfg, "id"), cdg: [], imports: cpProv,
    };
    const findings = solveTaint(new Map([["handler", pdg]]), NO_CALLS, registry);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.sinkKind).toBe("command");
    expect(findings[0]?.sanitized).toBe(false);
  });

  it("yields NO unsanitized finding when the value passes through a sanitizer", async () => {
    const cfg = await cfgOf(`
      function handler(req: any) {
        const raw = req.query.id;
        const id = encodeURIComponent(raw);
        exec(id);
      }
    `);
    // def→use for BOTH variables (raw produced by source; id by the sanitizer).
    const pdg: FunctionPdg = {
      symbolId: "handler", language: "typescript", cfg,
      defUse: [...fullDefUse(cfg, "raw"), ...fullDefUse(cfg, "id")], cdg: [], imports: cpProv,
    };
    const findings = solveTaint(new Map([["handler", pdg]]), NO_CALLS, registry);
    // Either no finding surfaces, or the surfaced one is marked sanitized.
    expect(findings.every((f) => f.sanitized === true)).toBe(true);
  });

  it("parameterized query is NOT flagged as a sql sink", async () => {
    const cfg = await cfgOf(`
      function handler(req: any, db: any) {
        const id = req.query.id;
        db.query("SELECT * FROM u WHERE id = ?", [id]);
      }
    `);
    const pdg: FunctionPdg = {
      symbolId: "handler", language: "typescript", cfg,
      defUse: fullDefUse(cfg, "id"), cdg: [], imports: cpProv,
    };
    const findings = solveTaint(new Map([["handler", pdg]]), NO_CALLS, registry);
    expect(findings.filter((f) => f.sinkKind === "sql" && !f.sanitized)).toHaveLength(0);
  });

  it("a raw string-concat sql query IS flagged as a `sql` finding", async () => {
    const cfg = await cfgOf(`
      function handler(req: any, db: any) {
        const id = req.query.id;
        db.query("SELECT * FROM u WHERE id = " + id);
      }
    `);
    const pdg: FunctionPdg = {
      symbolId: "handler", language: "typescript", cfg,
      defUse: fullDefUse(cfg, "id"), cdg: [], imports: cpProv,
    };
    const findings = solveTaint(new Map([["handler", pdg]]), NO_CALLS, registry);
    expect(findings.some((f) => f.sinkKind === "sql")).toBe(true);
  });
});

// Interprocedural taint (a caller passing a tainted arg into a helper that sinks
// it) is the E1 FOLLOW-UP — see "Interprocedural taint — E1 follow-up" in Task 4.
// It is intentionally NOT tested here: the MVP solver is intra-procedural, so a
// test asserting a cross-function `command` finding cannot pass yet, and adding
// it as `it.skip` would be a false green. It lives in the follow-up plan instead.
//
// The HARD-RULE invariant it used to also check — solveTaint returns TaintFinding
// objects (nodes), never Symbol→Symbol edges — is covered intra-proc below:
describe("solveTaint — HARD RULE (no edges emitted)", () => {
  it("returns only TaintFinding node objects, never a Relationship", async () => {
    const cfg = await cfgOf(`
      function handler(req: any) {
        const id = req.query.id;
        exec(id);
      }
    `);
    const pdg: FunctionPdg = {
      symbolId: "handler", language: "typescript", cfg,
      defUse: fullDefUse(cfg, "id"), cdg: [], imports: cpProv,
    };
    const findings = solveTaint(new Map([["handler", pdg]]), NO_CALLS, registry);
    expect(findings.every((f) => "sinkKind" in f && "sourceId" in f && "sinkId" in f && !("relType" in f))).toBe(true);
  });
});
