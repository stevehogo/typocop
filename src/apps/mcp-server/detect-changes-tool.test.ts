/**
 * Unit tests for the detect_changes MCP tool (C2).
 *
 * Uses a FAKE GitPort (canned FileDiff[]) + a mocked GraphAdapter so the whole
 * compose chain (git.diff → resolveChangedSymbols → executePreCommitCheck →
 * formatMCPResponse) runs without a real repo or DB.
 */
import { describe, it, expect, vi } from "vitest";
import type { DatabaseAdapter, GraphAdapter, VectorAdapter, EmbeddingAdapter } from "../../core/ports/persistence.js";
import type { GitPort, FileDiff, DiffScope } from "../../core/ports/git.js";
import { executeDetectChanges } from "./detect-changes-tool.js";
import { executeTool } from "./tools.js";

// ── Fake GitPort ────────────────────────────────────────────────────────────

function fakeGit(opts: {
  isRepo?: boolean;
  diffs?: FileDiff[];
  onDiff?: (scope: DiffScope, baseRef?: string) => void;
}): GitPort {
  return {
    isRepository: vi.fn().mockResolvedValue(opts.isRepo ?? true),
    diff: vi.fn(async (scope: DiffScope, baseRef?: string) => {
      opts.onDiff?.(scope, baseRef);
      return opts.diffs ?? [];
    }),
    currentRef: vi.fn().mockResolvedValue("abc1234"),
  };
}

// ── Mocked GraphAdapter that serves canned Symbol rows ────────────────────────

interface FakeSymbol {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  kind?: string;
}

/**
 * Build a GraphAdapter whose runCypher answers the queries the compose chain
 * issues:
 *  - resolveChangedSymbols: `RETURN s.id AS id, ...` (flat rows)
 *  - pre-commit findSymbolsInFiles: `... RETURN s` (wrapped rows)
 *  - dependents / processes / clusters: empty
 */
function createGraphAdapter(symbols: FakeSymbol[]): GraphAdapter {
  const runCypher = vi.fn(async (query: string, params?: Record<string, unknown>) => {
    const paths = (params?.["paths"] ?? params?.["filePaths"]) as string[] | undefined;

    // resolveChangedSymbols flat-row query
    if (query.includes("s.id AS id") && query.includes("s.filePath AS filePath")) {
      return symbols
        .filter((s) => !paths || paths.includes(s.filePath))
        .map((s) => ({ id: s.id, filePath: s.filePath, startLine: s.startLine, endLine: s.endLine }));
    }

    // pre-commit findSymbolsInFiles wrapped-row query
    if (query.includes("MATCH (s:Symbol) WHERE s.filePath IN $filePaths RETURN s")) {
      return symbols
        .filter((s) => !paths || paths.includes(s.filePath))
        .map((s) => ({
          s: {
            labels: ["Symbol"],
            properties: {
              id: s.id,
              name: s.name,
              kind: s.kind ?? "function",
              filePath: s.filePath,
              startLine: String(s.startLine),
              endLine: String(s.endLine),
              startColumn: "0",
              endColumn: "0",
              visibility: "public",
            },
          },
        }));
    }

    // dependents / processes / clusters / steps → none
    return [];
  });

  return {
    createNode: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue(undefined),
    queryNodes: vi.fn().mockResolvedValue([]),
    queryRelationships: vi.fn().mockResolvedValue([]),
    deleteNodesByLabel: vi.fn().mockResolvedValue(0),
    deleteRelationshipsByType: vi.fn().mockResolvedValue(0),
    runCypher,
    runCypherWrite: vi.fn().mockResolvedValue(undefined),
  } as unknown as GraphAdapter;
}

function createAdapter(symbols: FakeSymbol[]): DatabaseAdapter {
  const graph = createGraphAdapter(symbols);
  const vector: VectorAdapter = {
    createTables: vi.fn().mockResolvedValue(undefined),
    indexSymbol: vi.fn().mockResolvedValue(undefined),
    semanticSearch: vi.fn().mockResolvedValue([]),
    deleteAll: vi.fn().mockResolvedValue(0),
  } as unknown as VectorAdapter;
  const embedding: EmbeddingAdapter = {
    isEnabled: vi.fn().mockReturnValue(false),
    embedText: vi.fn().mockResolvedValue(null),
    getDimensions: vi.fn().mockReturnValue(2560),
  } as unknown as EmbeddingAdapter;
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getGraphAdapter: vi.fn().mockReturnValue(graph),
    getVectorAdapter: vi.fn().mockReturnValue(vector),
    getEmbeddingAdapter: vi.fn().mockReturnValue(embedding),
  } as unknown as DatabaseAdapter;
}

const modifiedDiff = (path: string, newStart = 1, newLines = 20): FileDiff => ({
  path,
  status: "modified",
  hunks: [{ newStart, newLines }],
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("executeDetectChanges", () => {
  it("elevates risk to CRITICAL when a changed file owns an auth-named symbol", async () => {
    const adapter = createAdapter([
      { id: "sym-auth", name: "authenticateUser", filePath: "src/auth.ts", startLine: 1, endLine: 30 },
    ]);
    const git = fakeGit({ diffs: [modifiedDiff("src/auth.ts")] });

    const res = await executeDetectChanges({ scope: "staged" }, adapter, git);

    expect(res.riskLevel).toBe("critical");
    expect(res.summary).toContain("Risk: CRITICAL");
    expect(res.summary).toContain("Detected 1 changed file(s) (staged)");
    expect(res.confidence).toBeGreaterThan(0);
    expect(typeof res.summary).toBe("string");
    expect(res.summary.length).toBeGreaterThan(0);
  });

  it("elevates risk to CRITICAL for a payment-named symbol", async () => {
    const adapter = createAdapter([
      { id: "sym-pay", name: "processPayment", filePath: "src/billing.ts", startLine: 5, endLine: 25 },
    ]);
    const git = fakeGit({ diffs: [modifiedDiff("src/billing.ts", 5, 10)] });

    const res = await executeDetectChanges({}, adapter, git);

    expect(res.riskLevel).toBe("critical");
  });

  it("returns a low-risk response when the changed file owns no risky symbols", async () => {
    const adapter = createAdapter([
      { id: "sym-util", name: "formatDate", filePath: "src/util.ts", startLine: 1, endLine: 10 },
    ]);
    const git = fakeGit({ diffs: [modifiedDiff("src/util.ts", 1, 5)] });

    const res = await executeDetectChanges({}, adapter, git);

    expect(res.riskLevel).toBe("low");
    expect(res.summary).toContain("1 affected symbol(s)");
  });

  it("returns a clean low-risk response (confidence 0.95) when not a git repository", async () => {
    const adapter = createAdapter([]);
    const git = fakeGit({ isRepo: false });

    const res = await executeDetectChanges({}, adapter, git);

    expect(res.riskLevel).toBe("low");
    expect(res.confidence).toBe(0.95);
    expect(res.symbols).toHaveLength(0);
    expect(res.summary).toContain("Not a git repository");
    expect(git.diff).not.toHaveBeenCalled();
  });

  it("returns a clean low-risk response (confidence 0.95) when there are no changes", async () => {
    const adapter = createAdapter([]);
    const git = fakeGit({ diffs: [] });

    const res = await executeDetectChanges({ scope: "all" }, adapter, git);

    expect(res.riskLevel).toBe("low");
    expect(res.confidence).toBe(0.95);
    expect(res.summary).toContain("No changes detected (all)");
  });

  it("defaults scope to 'unstaged' and forwards baseRef for compare", async () => {
    let seen: { scope: DiffScope; baseRef?: string } | undefined;
    const adapter = createAdapter([]);
    const gitDefault = fakeGit({ diffs: [], onDiff: (scope, baseRef) => (seen = { scope, baseRef }) });
    await executeDetectChanges({}, adapter, gitDefault);
    expect(seen?.scope).toBe("unstaged");

    seen = undefined;
    const gitCompare = fakeGit({ diffs: [], onDiff: (scope, baseRef) => (seen = { scope, baseRef }) });
    await executeDetectChanges({ scope: "compare", baseRef: "main" }, adapter, gitCompare);
    expect(seen).toEqual({ scope: "compare", baseRef: "main" });
  });

  it("reports risk at file granularity (pre-commit blast radius is per-file)", async () => {
    // C1 resolveChangedSymbols narrows to the hunk-overlapping symbol(s) and
    // returns the OWNING file paths; executePreCommitCheck then assesses the
    // whole file's blast radius. So a risky symbol elsewhere in the same file
    // still elevates risk — the seam is intentionally file-granular.
    const adapter = createAdapter([
      { id: "sym-auth", name: "authGuard", filePath: "src/auth.ts", startLine: 1, endLine: 10 },
      { id: "sym-other", name: "helper", filePath: "src/auth.ts", startLine: 50, endLine: 60 },
    ]);
    const git = fakeGit({ diffs: [modifiedDiff("src/auth.ts", 50, 6)] });

    const res = await executeDetectChanges({}, adapter, git);

    expect(res.riskLevel).toBe("critical");
    // Both symbols in the owning file are surfaced as the blast radius.
    expect(res.summary).toContain("2 affected symbol(s)");
  });
});

describe("executeTool — detect_changes routing (backward compatibility)", () => {
  it("routes detect_changes through executeTool when git is injected", async () => {
    const adapter = createAdapter([
      { id: "sym-auth", name: "authenticateUser", filePath: "src/auth.ts", startLine: 1, endLine: 30 },
    ]);
    const git = fakeGit({ diffs: [modifiedDiff("src/auth.ts")] });

    const res = await executeTool("detect_changes", { scope: "staged" }, adapter, git);

    expect(res.riskLevel).toBe("critical");
    expect(res).toHaveProperty("summary");
  });

  it("throws if detect_changes is invoked without a GitPort", async () => {
    const adapter = createAdapter([]);
    await expect(executeTool("detect_changes", {}, adapter)).rejects.toThrow(/GitPort/);
  });

  it("existing tools still work without a GitPort (git param optional)", async () => {
    const adapter = createAdapter([]);
    const res = await executeTool("get_symbol_context", { symbolName: "foo" }, adapter);
    expect(res).toHaveProperty("summary");
  });
});
