/**
 * Plan E #7 — the --pdg gate. With pdg:true, the pipeline writes BasicBlock /
 * TaintFinding nodes + CFG/TAINT_SINK edges; with pdg:false (default) it writes
 * NONE of them (the sibling pipeline.test.ts drift-guard stays green). A recording
 * GraphAdapter captures every node label / edge type written.
 *
 * Reproduces the sibling pipeline.test.ts mock harness, additionally mocking
 * `readFileContents` (the PDG phase reads source text on demand).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Symbol } from "../../core/domain.js";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../../core/ports/persistence.js";

const STUB_SYMBOL: Symbol = {
  id: "stub", logicalKey: "stub", name: "stub", kind: "function",
  location: { filePath: "stub.ts", startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
  visibility: "public", modifiers: [],
};

const INJECT_CONTENT = [
  `import { exec } from "child_process";`,
  `export function handler(req: any) { const id = req.query.id; exec(id); }`,
].join("\n");

const {
  mockWalkFileTree, mockReadFileContents, mockExtractAllSymbols, mockResolveReferences,
  mockClusterSymbols, mockTraceProcesses, mockAnnotateEntryPoints, mockBuildSearchIndex,
} = vi.hoisted(() => ({
  mockWalkFileTree: vi.fn(),
  mockReadFileContents: vi.fn(),
  mockExtractAllSymbols: vi.fn(),
  mockResolveReferences: vi.fn(),
  mockClusterSymbols: vi.fn(),
  mockTraceProcesses: vi.fn(),
  mockAnnotateEntryPoints: vi.fn((symbols: unknown) => symbols),
  mockBuildSearchIndex: vi.fn(),
}));

vi.mock("./structure/index.js", () => ({ walkFileTree: mockWalkFileTree, readFileContents: mockReadFileContents }));
vi.mock("./parsing/index.js", () => ({ extractAllSymbols: mockExtractAllSymbols }));
vi.mock("./resolution/index.js", () => ({ resolveReferences: mockResolveReferences }));
vi.mock("./clustering/index.js", () => ({ clusterSymbols: mockClusterSymbols }));
vi.mock("./processes/index.js", () => ({ traceProcesses: mockTraceProcesses, annotateEntryPoints: mockAnnotateEntryPoints }));
vi.mock("./search/index.js", () => ({ buildSearchIndex: mockBuildSearchIndex }));
vi.mock("../../platform/config/index.js", () => ({ configurationManager: { getPrefix: () => "tpc_" } }));

import { runIndexingPipeline } from "./pipeline.js";

function makeRecordingAdapter(): {
  adapter: DatabaseAdapter; writtenNodeLabels: string[]; writtenEdgeTypes: string[];
} {
  const writtenNodeLabels: string[] = [];
  const writtenEdgeTypes: string[] = [];
  const graph: GraphAdapter = {
    createNode: vi.fn(async (label: string) => { writtenNodeLabels.push(label); }),
    createRelationship: vi.fn(async (_f: string, _t: string, type: string) => { writtenEdgeTypes.push(type); }),
    queryNodes: vi.fn().mockResolvedValue([]),
    queryRelationships: vi.fn().mockResolvedValue([]),
    deleteNodesByLabel: vi.fn().mockResolvedValue(0),
    deleteRelationshipsByType: vi.fn().mockResolvedValue(0),
    runCypher: vi.fn().mockResolvedValue([]),
    runCypherWrite: vi.fn().mockResolvedValue(undefined),
  };
  const vector: VectorAdapter = {
    createTables: vi.fn().mockResolvedValue(undefined),
    indexSymbol: vi.fn().mockResolvedValue(undefined),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn().mockResolvedValue(0),
  };
  const embedding: EmbeddingAdapter = {
    isEnabled: vi.fn().mockReturnValue(false),
    embedText: vi.fn().mockResolvedValue(null),
    getDimensions: vi.fn().mockReturnValue(2560),
  };
  const adapter: DatabaseAdapter = {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getGraphAdapter: vi.fn().mockReturnValue(graph),
    getVectorAdapter: vi.fn().mockReturnValue(vector),
    getEmbeddingAdapter: vi.fn().mockReturnValue(embedding),
  };
  return { adapter, writtenNodeLabels, writtenEdgeTypes };
}

const handlerSymbol: Symbol = {
  ...STUB_SYMBOL, id: "inject.ts#handler", logicalKey: "inject.ts#handler", name: "handler", kind: "function",
  location: { filePath: "inject.ts", startLine: 2, startColumn: 0, endLine: 2, endColumn: 0 },
};

function setupDefaultMocks(): void {
  mockWalkFileTree.mockResolvedValue([{ path: "inject.ts", size: 100 }]);
  mockReadFileContents.mockResolvedValue(new Map([["inject.ts", INJECT_CONTENT]]));
  mockExtractAllSymbols.mockResolvedValue({ symbols: [handlerSymbol], hints: [], skippedFiles: 0 });
  mockResolveReferences.mockReturnValue({ relationships: [], extNodes: new Map() });
  mockClusterSymbols.mockResolvedValue([]);
  mockTraceProcesses.mockReturnValue([]);
  mockAnnotateEntryPoints.mockImplementation((symbols: unknown) => symbols);
  mockBuildSearchIndex.mockResolvedValue({
    keywords: new Map(), symbolCount: 1, embeddings: [],
    embeddingStats: { attempts: 0, successes: 0, failures: 0 },
  });
}

describe("runIndexingPipeline — --pdg gate (Plan E #7)", () => {
  beforeEach(() => { vi.clearAllMocks(); setupDefaultMocks(); });

  it("pdg:true persists BasicBlock + TaintFinding nodes and PDG/taint edges", async () => {
    const { adapter, writtenNodeLabels, writtenEdgeTypes } = makeRecordingAdapter();
    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter, pdg: true });
    expect(writtenNodeLabels).toContain("BasicBlock");
    expect(writtenNodeLabels).toContain("TaintFinding");
    expect(writtenEdgeTypes).toContain("CFG");
    expect(writtenEdgeTypes).toContain("TAINT_SINK");
    // HARD RULE: no SANITIZES edge is ever written.
    expect(writtenEdgeTypes).not.toContain("SANITIZES");
  });

  it("pdg:false (default) writes NO PDG/taint node or edge", async () => {
    const { adapter, writtenNodeLabels, writtenEdgeTypes } = makeRecordingAdapter();
    await runIndexingPipeline({ sourcePath: ".", language: "typescript", verbose: false, adapter });
    for (const label of ["BasicBlock", "TaintFinding"]) expect(writtenNodeLabels).not.toContain(label);
    for (const t of ["CFG", "CDG", "REACHING_DEF", "HAS_BLOCK", "TAINT_SOURCE", "TAINT_SINK", "SANITIZES"]) {
      expect(writtenEdgeTypes).not.toContain(t);
    }
  });
});
