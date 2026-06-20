/**
 * Unit tests for C1 resolveChangedSymbols — overlap logic over a mocked GraphAdapter.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveChangedSymbols } from "./changed-symbols.js";
import type { GraphAdapter } from "../../core/ports/persistence.js";
import type { FileDiff } from "../../core/ports/git.js";

interface Row {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

/** Build a GraphAdapter whose runCypher returns the given symbol rows. */
function mockGraph(rows: Row[]): { adapter: GraphAdapter; runCypher: ReturnType<typeof vi.fn> } {
  const runCypher = vi.fn(async (_q: string, _p?: Record<string, unknown>) => rows as unknown[]);
  const adapter = {
    runCypher,
  } as unknown as GraphAdapter;
  return { adapter, runCypher };
}

describe("resolveChangedSymbols", () => {
  it("returns empty result for no diffs without touching the DB", async () => {
    const { adapter, runCypher } = mockGraph([]);
    const result = await resolveChangedSymbols([], adapter);
    expect(result).toEqual({ changedFiles: [], symbolIds: [] });
    expect(runCypher).not.toHaveBeenCalled();
  });

  it("selects only symbols whose line range overlaps a hunk", async () => {
    const rows: Row[] = [
      { id: "a", filePath: "src/a.ts", startLine: 1, endLine: 5 },
      { id: "b", filePath: "src/a.ts", startLine: 10, endLine: 20 },
      { id: "c", filePath: "src/a.ts", startLine: 30, endLine: 40 },
    ];
    const { adapter } = mockGraph(rows);
    const diffs: FileDiff[] = [
      { path: "src/a.ts", status: "modified", hunks: [{ newStart: 12, newLines: 2 }] },
    ];
    const result = await resolveChangedSymbols(diffs, adapter);
    // Only "b" [10..20] overlaps hunk [12..13].
    expect(result.symbolIds).toEqual(["b"]);
    expect(result.changedFiles).toEqual(["src/a.ts"]);
  });

  it("matches boundary-touching ranges (inclusive overlap)", async () => {
    const rows: Row[] = [
      { id: "edge", filePath: "src/a.ts", startLine: 5, endLine: 10 },
    ];
    const { adapter } = mockGraph(rows);
    // Hunk starts exactly at the symbol's end line.
    const diffs: FileDiff[] = [
      { path: "src/a.ts", status: "modified", hunks: [{ newStart: 10, newLines: 1 }] },
    ];
    const result = await resolveChangedSymbols(diffs, adapter);
    expect(result.symbolIds).toEqual(["edge"]);
  });

  it("selects ALL symbols in a deleted file regardless of hunks", async () => {
    const rows: Row[] = [
      { id: "x", filePath: "src/gone.ts", startLine: 1, endLine: 5 },
      { id: "y", filePath: "src/gone.ts", startLine: 100, endLine: 200 },
    ];
    const { adapter } = mockGraph(rows);
    const diffs: FileDiff[] = [{ path: "src/gone.ts", status: "deleted", hunks: [] }];
    const result = await resolveChangedSymbols(diffs, adapter);
    expect(result.symbolIds).toEqual(["x", "y"]);
    expect(result.changedFiles).toEqual(["src/gone.ts"]);
  });

  it("selects ALL symbols when a modified file reports no hunks (whole-file change)", async () => {
    const rows: Row[] = [
      { id: "x", filePath: "src/a.ts", startLine: 1, endLine: 5 },
      { id: "y", filePath: "src/a.ts", startLine: 50, endLine: 60 },
    ];
    const { adapter } = mockGraph(rows);
    const diffs: FileDiff[] = [{ path: "src/a.ts", status: "added", hunks: [] }];
    const result = await resolveChangedSymbols(diffs, adapter);
    expect(result.symbolIds).toEqual(["x", "y"]);
  });

  it("handles multiple hunks and multiple files", async () => {
    const rows: Row[] = [
      { id: "a1", filePath: "src/a.ts", startLine: 1, endLine: 3 },
      { id: "a2", filePath: "src/a.ts", startLine: 40, endLine: 45 },
      { id: "a3", filePath: "src/a.ts", startLine: 90, endLine: 95 },
      { id: "b1", filePath: "src/b.ts", startLine: 1, endLine: 100 },
    ];
    const { adapter } = mockGraph(rows);
    const diffs: FileDiff[] = [
      {
        path: "src/a.ts",
        status: "modified",
        hunks: [
          { newStart: 2, newLines: 1 },
          { newStart: 92, newLines: 1 },
        ],
      },
      { path: "src/b.ts", status: "modified", hunks: [{ newStart: 5, newLines: 1 }] },
    ];
    const result = await resolveChangedSymbols(diffs, adapter);
    expect(result.symbolIds).toEqual(["a1", "a3", "b1"]);
    expect(result.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("includes the old path of a rename in the query and overlap test", async () => {
    const rows: Row[] = [
      { id: "old", filePath: "src/old.ts", startLine: 1, endLine: 10 },
      { id: "new", filePath: "src/new.ts", startLine: 1, endLine: 10 },
    ];
    const { adapter, runCypher } = mockGraph(rows);
    const diffs: FileDiff[] = [
      {
        path: "src/new.ts",
        status: "renamed",
        oldPath: "src/old.ts",
        hunks: [{ newStart: 2, newLines: 1 }],
      },
    ];
    const result = await resolveChangedSymbols(diffs, adapter);
    // Both old and new paths queried.
    const params = runCypher.mock.calls[0][1] as { paths: string[] };
    expect(params.paths.sort()).toEqual(["src/new.ts", "src/old.ts"]);
    expect(result.symbolIds).toEqual(["new", "old"]);
  });

  it("deduplicates ids and sorts output", async () => {
    const rows: Row[] = [
      { id: "z", filePath: "src/a.ts", startLine: 1, endLine: 5 },
      { id: "a", filePath: "src/a.ts", startLine: 1, endLine: 5 },
    ];
    const { adapter } = mockGraph(rows);
    const diffs: FileDiff[] = [{ path: "src/a.ts", status: "deleted", hunks: [] }];
    const result = await resolveChangedSymbols(diffs, adapter);
    expect(result.symbolIds).toEqual(["a", "z"]);
  });
});
