import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LbugValue } from "@ladybugdb/core";
import { LadybugGraphAdapter } from "./ladybug-graph-adapter.js";

function mockQueryResult(rows: Record<string, LbugValue>[]) {
  return { getAll: async () => rows };
}
const mockQuery = vi.fn().mockResolvedValue(mockQueryResult([]));
const mockConnection = {
  query: mockQuery,
  prepare: vi.fn().mockResolvedValue({ isSuccess: () => true, getErrorMessage: () => "" }),
  execute: vi.fn().mockResolvedValue(mockQueryResult([])),
  init: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

describe("LadybugGraphAdapter PDG/taint schema (Plan A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue(mockQueryResult([]));
  });

  async function ddl(): Promise<string[]> {
    const adapter = new LadybugGraphAdapter(mockConnection as never, "tpc_");
    await adapter.initializeSchema();
    return mockQuery.mock.calls.map((c) => c[0] as string);
  }

  it("creates the BasicBlock and TaintFinding node tables (all-STRING props, PK id)", async () => {
    const q = await ddl();
    const bb = q.find((s) => /CREATE NODE TABLE IF NOT EXISTS tpc_BasicBlock\b/.test(s));
    expect(bb).toBeDefined();
    for (const col of ["functionId", "blockIndex", "startLine", "endLine", "kind"]) {
      expect(bb).toContain(`${col} STRING`);
    }
    expect(bb).toContain("PRIMARY KEY(id)");

    const tf = q.find((s) => /CREATE NODE TABLE IF NOT EXISTS tpc_TaintFinding\b/.test(s));
    expect(tf).toBeDefined();
    for (const col of ["sinkKind", "sourceId", "sinkId", "sourceLoc", "sinkLoc", "sanitized", "pathJson"]) {
      expect(tf).toContain(`${col} STRING`);
    }
    expect(tf).toContain("PRIMARY KEY(id)");
  });

  it("creates the seven PDG/taint rel tables with the correct FROM/TO labels", async () => {
    const q = await ddl();
    const has = (re: RegExp) => expect(q.some((s) => re.test(s))).toBe(true);
    has(/CREATE REL TABLE IF NOT EXISTS tpc_HAS_BLOCK\s*\(FROM tpc_Symbol TO tpc_BasicBlock/);
    has(/CREATE REL TABLE IF NOT EXISTS tpc_CFG\s*\(FROM tpc_BasicBlock TO tpc_BasicBlock/);
    has(/CREATE REL TABLE IF NOT EXISTS tpc_CDG\s*\(FROM tpc_BasicBlock TO tpc_BasicBlock/);
    has(/CREATE REL TABLE IF NOT EXISTS tpc_REACHING_DEF\s*\(FROM tpc_BasicBlock TO tpc_BasicBlock/);
    has(/CREATE REL TABLE IF NOT EXISTS tpc_TAINT_SOURCE\s*\(FROM tpc_Symbol TO tpc_TaintFinding/);
    has(/CREATE REL TABLE IF NOT EXISTS tpc_TAINT_SINK\s*\(FROM tpc_TaintFinding TO tpc_Symbol/);
    has(/CREATE REL TABLE IF NOT EXISTS tpc_SANITIZES\s*\(FROM tpc_Symbol TO tpc_Symbol/);
  });

  it("declares the prop columns on the prop-carrying rel tables", async () => {
    const q = await ddl();
    const cfg = q.find((s) => /tpc_CFG\b/.test(s));
    expect(cfg).toContain("edgeKind STRING");
    const cdg = q.find((s) => /tpc_CDG\b/.test(s));
    expect(cdg).toContain("branchSense STRING");
    expect(cdg).toContain("guard STRING");
    const rd = q.find((s) => /tpc_REACHING_DEF\b/.test(s));
    expect(rd).toContain("variable STRING");
    const san = q.find((s) => /tpc_SANITIZES\b/.test(s));
    expect(san).toContain("sinkKind STRING");
  });

  it("does NOT create any Symbol→Symbol PDG/CFG edge (HARD RULE)", async () => {
    const q = await ddl();
    // cfg/cdg/reachingDef must be BasicBlock-ended, never Symbol→Symbol.
    expect(q.some((s) => /tpc_CFG\b.*FROM tpc_Symbol TO tpc_Symbol/.test(s))).toBe(false);
    expect(q.some((s) => /tpc_CDG\b.*FROM tpc_Symbol TO tpc_Symbol/.test(s))).toBe(false);
    expect(q.some((s) => /tpc_REACHING_DEF\b.*FROM tpc_Symbol TO tpc_Symbol/.test(s))).toBe(false);
  });

  it("prefixes the new PDG/taint labels + rel types in raw Cypher (prefixQuery)", () => {
    const adapter = new LadybugGraphAdapter(mockConnection as never, "tpc_");
    // prefixQuery is private; reach it via a typed cast for this allow-list guard.
    const prefix = (q: string) =>
      (adapter as unknown as { prefixQuery(x: string): string }).prefixQuery(q);
    const out = prefix("MATCH (s:Symbol)-[:HAS_BLOCK]->(b:BasicBlock)-[:CFG]->(c:BasicBlock) RETURN b");
    expect(out).toContain(":tpc_BasicBlock");
    expect(out).toContain(":tpc_HAS_BLOCK");
    expect(out).toContain(":tpc_CFG");
    for (const t of ["TaintFinding", "TAINT_SOURCE", "TAINT_SINK", "SANITIZES", "CDG", "REACHING_DEF"]) {
      expect(prefix(`:${t}`)).toBe(`:tpc_${t}`);
    }
  });
});
