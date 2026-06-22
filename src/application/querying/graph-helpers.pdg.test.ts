import { describe, it, expect } from "vitest";
import { graphNodeToBasicBlock, graphNodeToTaintFinding } from "./graph-helpers.js";
import type { GraphNode } from "../../core/ports/persistence.js";
import type { BasicBlock, TaintFinding } from "../../core/domain.js";

// Mirror how Plan E will persist these: every prop a STRING, numbers/booleans/
// arrays stringified. The helper must parse them back to the domain shape.
function persistBlock(b: BasicBlock): GraphNode {
  return {
    id: b.id,
    labels: ["BasicBlock"],
    properties: {
      id: b.id, functionId: b.functionId,
      blockIndex: String(b.blockIndex),
      startLine: String(b.startLine), endLine: String(b.endLine),
      kind: b.kind,
    },
  };
}
function persistFinding(f: TaintFinding): GraphNode {
  return {
    id: f.id,
    labels: ["TaintFinding"],
    properties: {
      id: f.id, sinkKind: f.sinkKind, sourceId: f.sourceId, sinkId: f.sinkId,
      sourceLoc: f.sourceLoc, sinkLoc: f.sinkLoc,
      sanitized: f.sanitized ? "true" : "false",
      pathJson: JSON.stringify(f.path),
    },
  };
}

describe("graphNodeToBasicBlock (round-trip)", () => {
  it("parses STRING props back into the BasicBlock domain shape", () => {
    const b: BasicBlock = { id: "fn#2", functionId: "fn", blockIndex: 2, startLine: 10, endLine: 14, kind: "branch" };
    expect(graphNodeToBasicBlock(persistBlock(b))).toEqual(b);
  });

  it("defaults numeric fields to 0 when the column is absent", () => {
    const node: GraphNode = { id: "x#0", labels: ["BasicBlock"], properties: { id: "x#0", functionId: "x", kind: "entry" } };
    const out = graphNodeToBasicBlock(node);
    expect(out.blockIndex).toBe(0);
    expect(out.startLine).toBe(0);
    expect(out.endLine).toBe(0);
    expect(out.kind).toBe("entry");
  });
});

describe("graphNodeToTaintFinding (round-trip)", () => {
  it("parses STRING props (incl. pathJson + boolean sanitized) back into TaintFinding", () => {
    const f: TaintFinding = {
      id: "tf:7", sinkKind: "sql", sourceId: "s", sinkId: "k",
      sourceLoc: "a.ts:1", sinkLoc: "a.ts:9", sanitized: true, path: ["fn#0", "fn#1", "fn#2"],
    };
    expect(graphNodeToTaintFinding(persistFinding(f))).toEqual(f);
  });

  it("treats sanitized !== 'true' as false and a missing/blank pathJson as []", () => {
    const node: GraphNode = {
      id: "tf:8", labels: ["TaintFinding"],
      properties: { id: "tf:8", sinkKind: "xss", sourceId: "s", sinkId: "k", sourceLoc: "", sinkLoc: "", sanitized: "false" },
    };
    const out = graphNodeToTaintFinding(node);
    expect(out.sanitized).toBe(false);
    expect(out.path).toEqual([]);
  });
});
