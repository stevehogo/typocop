import { describe, it, expect } from "vitest";
import type {
  RelationType,
  BlockKind,
  SinkKind,
  BasicBlock,
  TaintFinding,
} from "./domain.js";

describe("PDG/taint domain (Plan A)", () => {
  it("RelationType union includes the seven PDG/taint edge types", () => {
    // A value-level array typed as RelationType[] only compiles if every member
    // is a legal RelationType — this is the union-membership assertion.
    const pdgRelTypes: RelationType[] = [
      "hasBlock", "cfg", "cdg", "reachingDef", "taintSource", "taintSink", "sanitizes",
    ];
    expect(pdgRelTypes).toHaveLength(7);
    expect(new Set(pdgRelTypes).size).toBe(7); // no accidental dupes
  });

  it("does NOT drop the existing relTypes (additive only)", () => {
    const existing: RelationType[] = [
      "calls", "imports", "inherits", "implements", "contains", "references",
      "defines", "dependsOn", "overrides", "methodImplements",
      "readsFromDb", "writesToDb", "handlesRoute", "publishesEvent", "subscribesTo",
    ];
    expect(existing).toHaveLength(15);
  });

  it("BlockKind / SinkKind enumerate the documented literals", () => {
    const blocks: BlockKind[] = ["entry", "exit", "normal", "branch", "loop", "switch", "catch"];
    const sinks: SinkKind[] = ["command", "sql", "path", "xss", "code"];
    expect(blocks).toHaveLength(7);
    expect(sinks).toHaveLength(5);
  });

  it("BasicBlock has the README-documented shape", () => {
    const b: BasicBlock = {
      id: "fn#0", functionId: "fn", blockIndex: 0,
      startLine: 1, endLine: 3, kind: "entry",
    };
    expect(b.id).toBe("fn#0");
    expect(b.kind).toBe("entry");
  });

  it("TaintFinding has the README-documented shape (path is a string[])", () => {
    const f: TaintFinding = {
      id: "tf:1", sinkKind: "command",
      sourceId: "src", sinkId: "snk",
      sourceLoc: "a.ts:10", sinkLoc: "a.ts:42",
      sanitized: false, path: ["fn#0", "fn#1"],
    };
    expect(f.sinkKind).toBe("command");
    expect(f.path).toEqual(["fn#0", "fn#1"]);
    expect(f.sanitized).toBe(false);
  });
});
