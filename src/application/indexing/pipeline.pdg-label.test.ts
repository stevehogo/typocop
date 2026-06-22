import { describe, it, expect } from "vitest";
import { RELTYPE_EDGE_LABEL } from "./pipeline.js";
import type { RelationType } from "../../core/domain.js";

// The persist path is `RELTYPE_EDGE_LABEL[relType] ?? relType.toUpperCase()`
// (pipeline.ts). Verify each PDG/taint relType resolves to its REL-table label.
const resolve = (rt: RelationType): string => RELTYPE_EDGE_LABEL[rt] ?? rt.toUpperCase();

describe("RELTYPE_EDGE_LABEL — PDG/taint relTypes (Plan A)", () => {
  it("maps the multi-word camelCase relTypes explicitly (toUpperCase would mangle them)", () => {
    expect(resolve("hasBlock")).toBe("HAS_BLOCK");
    expect(resolve("reachingDef")).toBe("REACHING_DEF");
    expect(resolve("taintSource")).toBe("TAINT_SOURCE");
    expect(resolve("taintSink")).toBe("TAINT_SINK");
  });

  it("lets the single-word relTypes round-trip via toUpperCase (no map entry needed)", () => {
    expect(resolve("cfg")).toBe("CFG");
    expect(resolve("cdg")).toBe("CDG");
    expect(resolve("sanitizes")).toBe("SANITIZES");
    expect(RELTYPE_EDGE_LABEL.cfg).toBeUndefined();
    expect(RELTYPE_EDGE_LABEL.cdg).toBeUndefined();
    expect(RELTYPE_EDGE_LABEL.sanitizes).toBeUndefined();
  });

  it("naive toUpperCase WOULD mangle the multi-word ones (why the map exists)", () => {
    expect("hasBlock".toUpperCase()).toBe("HASBLOCK"); // ≠ HAS_BLOCK
    expect("reachingDef".toUpperCase()).toBe("REACHINGDEF");
  });
});
