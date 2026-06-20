/**
 * Unit tests for D2 impact-analysis explainability.
 * Covers the classifyNodeRole truth table (isolated/entry/utility/adapter/core)
 * and the explainAffectedNode confidence/reasons assembly.
 */
import { describe, it, expect } from "vitest";
import { classifyNodeRole, explainAffectedNode, type NodeDegree } from "./explainability.js";

const degree = (inDegree: number, outDegree: number, isExported = false): NodeDegree => ({
  inDegree,
  outDegree,
  isExported,
});

describe("classifyNodeRole — truth table", () => {
  it("(in 0, out 0) → Isolated", () => {
    expect(classifyNodeRole(degree(0, 0))).toBe("Isolated");
  });

  it("(in 0, out > 0) → EntryPoint", () => {
    expect(classifyNodeRole(degree(0, 1))).toBe("EntryPoint");
    expect(classifyNodeRole(degree(0, 9))).toBe("EntryPoint");
  });

  it("(in > 0, out 0) → Utility", () => {
    expect(classifyNodeRole(degree(1, 0))).toBe("Utility");
    expect(classifyNodeRole(degree(12, 0))).toBe("Utility");
  });

  it("skewed (few in, many out) → Adapter", () => {
    expect(classifyNodeRole(degree(1, 6))).toBe("Adapter");
    expect(classifyNodeRole(degree(2, 10))).toBe("Adapter");
  });

  it("skewed (many in, few out) → Adapter", () => {
    expect(classifyNodeRole(degree(6, 1))).toBe("Adapter");
    expect(classifyNodeRole(degree(10, 2))).toBe("Adapter");
  });

  it("balanced (both connected, not skewed) → CoreLogic", () => {
    expect(classifyNodeRole(degree(3, 3))).toBe("CoreLogic");
    expect(classifyNodeRole(degree(1, 1))).toBe("CoreLogic");
    expect(classifyNodeRole(degree(4, 4))).toBe("CoreLogic");
  });

  it("export status does not change connectivity classification", () => {
    expect(classifyNodeRole(degree(0, 0, true))).toBe("Isolated");
    expect(classifyNodeRole(degree(3, 3, true))).toBe("CoreLogic");
  });

  it("skew boundary: (2,5) is balanced (out not > 5), (2,6) is adapter", () => {
    expect(classifyNodeRole(degree(2, 5))).toBe("CoreLogic");
    expect(classifyNodeRole(degree(2, 6))).toBe("Adapter");
  });
});

describe("explainAffectedNode", () => {
  it("direct caller (hop 1, calls edge) gets high confidence + direct reason", () => {
    const e = explainAffectedNode({
      symbolId: "s1",
      entryEdge: "calls",
      hopDistance: 1,
      degree: degree(2, 2),
    });
    expect(e.nodeRole).toBe("CoreLogic");
    expect(e.entryEdge).toBe("calls");
    expect(e.hopDistance).toBe(1);
    expect(e.confidence).toBeGreaterThan(0.9);
    expect(e.reasons.some((r) => r.includes("Direct caller"))).toBe(true);
  });

  it("transitive node has lower confidence than a direct one", () => {
    const direct = explainAffectedNode({ symbolId: "a", entryEdge: "calls", hopDistance: 1, degree: degree(2, 2) });
    const transitive = explainAffectedNode({ symbolId: "b", entryEdge: "calls", hopDistance: 3, degree: degree(2, 2) });
    expect(transitive.confidence).toBeLessThan(direct.confidence);
  });

  it("structural edge (contains) is a weaker signal than a calls edge", () => {
    const calls = explainAffectedNode({ symbolId: "a", entryEdge: "calls", hopDistance: 1, degree: degree(2, 2) });
    const contains = explainAffectedNode({ symbolId: "b", entryEdge: "contains", hopDistance: 1, degree: degree(2, 2) });
    expect(contains.confidence).toBeLessThan(calls.confidence);
    expect(contains.reasons.some((r) => r.includes("structural"))).toBe(true);
  });

  it("isolated non-exported node is low confidence with a verify-dynamic reason", () => {
    const e = explainAffectedNode({ symbolId: "x", entryEdge: "calls", hopDistance: 1, degree: degree(0, 0, false) });
    expect(e.nodeRole).toBe("Isolated");
    expect(e.confidence).toBeLessThan(0.7);
    expect(e.reasons.some((r) => r.toLowerCase().includes("isolated"))).toBe(true);
  });

  it("exported isolated node is penalised less than a non-exported one", () => {
    const exported = explainAffectedNode({ symbolId: "x", entryEdge: "calls", hopDistance: 1, degree: degree(0, 0, true) });
    const notExported = explainAffectedNode({ symbolId: "y", entryEdge: "calls", hopDistance: 1, degree: degree(0, 0, false) });
    expect(exported.confidence).toBeGreaterThan(notExported.confidence);
  });

  it("confidence is always clamped to [0, 1]", () => {
    const e = explainAffectedNode({ symbolId: "x", entryEdge: "contains", hopDistance: 20, degree: degree(0, 0, false) });
    expect(e.confidence).toBeGreaterThanOrEqual(0);
    expect(e.confidence).toBeLessThanOrEqual(1);
  });

  it("emits a role-specific reason for each role", () => {
    expect(explainAffectedNode({ symbolId: "e", entryEdge: "calls", hopDistance: 1, degree: degree(0, 3) }).reasons.some((r) => r.includes("Entry point"))).toBe(true);
    expect(explainAffectedNode({ symbolId: "u", entryEdge: "calls", hopDistance: 1, degree: degree(3, 0) }).reasons.some((r) => r.includes("Utility"))).toBe(true);
    expect(explainAffectedNode({ symbolId: "a", entryEdge: "calls", hopDistance: 1, degree: degree(1, 6) }).reasons.some((r) => r.includes("Adapter"))).toBe(true);
    expect(explainAffectedNode({ symbolId: "c", entryEdge: "calls", hopDistance: 1, degree: degree(3, 3) }).reasons.some((r) => r.includes("Core logic"))).toBe(true);
  });
});
