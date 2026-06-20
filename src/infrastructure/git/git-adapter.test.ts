/**
 * Unit tests for the C1 git-diff parsers (pure, no real repo).
 */
import { describe, it, expect } from "vitest";
import {
  parseNameStatus,
  parseUnifiedDiff,
  combineDiff,
} from "./git-adapter.js";

// Identity normaliser for tests that don't exercise path translation.
const identity = (p: string): string => p;

describe("parseNameStatus", () => {
  it("parses added / modified / deleted records", () => {
    const raw = ["A\tsrc/new.ts", "M\tsrc/edited.ts", "D\tsrc/gone.ts"].join("\n");
    expect(parseNameStatus(raw)).toEqual([
      { status: "added", path: "src/new.ts" },
      { status: "modified", path: "src/edited.ts" },
      { status: "deleted", path: "src/gone.ts" },
    ]);
  });

  it("parses a rename with old + new path", () => {
    const raw = "R096\tsrc/old-name.ts\tsrc/new-name.ts";
    expect(parseNameStatus(raw)).toEqual([
      { status: "renamed", path: "src/new-name.ts", oldPath: "src/old-name.ts" },
    ]);
  });

  it("treats a copy as an addition derived from old", () => {
    const raw = "C100\tsrc/template.ts\tsrc/copy.ts";
    expect(parseNameStatus(raw)).toEqual([
      { status: "added", path: "src/copy.ts", oldPath: "src/template.ts" },
    ]);
  });

  it("treats a typechange as a modification", () => {
    expect(parseNameStatus("T\tsrc/link.ts")).toEqual([
      { status: "modified", path: "src/link.ts" },
    ]);
  });

  it("ignores blank lines, CRLF, and unknown statuses", () => {
    const raw = "M\tsrc/a.ts\r\n\nU\tsrc/conflict.ts\nA\tsrc/b.ts";
    expect(parseNameStatus(raw)).toEqual([
      { status: "modified", path: "src/a.ts" },
      { status: "added", path: "src/b.ts" },
    ]);
  });

  it("returns empty for empty input", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("parseUnifiedDiff", () => {
  it("parses a single-hunk modification", () => {
    const raw = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@ function foo() {",
      "-old",
      "+new1",
      "+new2",
    ].join("\n");
    expect(parseUnifiedDiff(raw).get("src/a.ts")).toEqual([
      { newStart: 10, newLines: 3 },
    ]);
  });

  it("parses multiple hunks in one file", () => {
    const raw = [
      "--- a/src/multi.ts",
      "+++ b/src/multi.ts",
      "@@ -1,0 +2,1 @@",
      "+added line",
      "@@ -20,1 +22,4 @@ class Bar {",
      "+a",
      "+b",
      "+c",
      "+d",
    ].join("\n");
    expect(parseUnifiedDiff(raw).get("src/multi.ts")).toEqual([
      { newStart: 2, newLines: 1 },
      { newStart: 22, newLines: 4 },
    ]);
  });

  it("treats a header without a comma as newLines = 1", () => {
    const raw = ["--- a/src/one.ts", "+++ b/src/one.ts", "@@ -5 +5 @@", "-x", "+y"].join("\n");
    expect(parseUnifiedDiff(raw).get("src/one.ts")).toEqual([
      { newStart: 5, newLines: 1 },
    ]);
  });

  it("records a new (added) file with its hunk", () => {
    const raw = [
      "--- /dev/null",
      "+++ b/src/added.ts",
      "@@ -0,0 +1,3 @@",
      "+line1",
      "+line2",
      "+line3",
    ].join("\n");
    const map = parseUnifiedDiff(raw);
    expect(map.get("src/added.ts")).toEqual([{ newStart: 1, newLines: 3 }]);
  });

  it("yields no entry for a deleted file (new path is /dev/null)", () => {
    const raw = [
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-line1",
      "-line2",
      "-line3",
    ].join("\n");
    const map = parseUnifiedDiff(raw);
    expect(map.has("src/gone.ts")).toBe(false);
    expect(map.size).toBe(0);
  });
});

describe("combineDiff", () => {
  it("attaches hunks, drops ignored files, and clears hunks for deletions", () => {
    const nameStatus = [
      { status: "modified" as const, path: "src/a.ts" },
      { status: "deleted" as const, path: "src/gone.ts" },
      { status: "added" as const, path: "node_modules/pkg/index.js" },
    ];
    const hunks = new Map([
      ["src/a.ts", [{ newStart: 1, newLines: 2 }]],
      ["src/gone.ts", []],
    ]);
    const result = combineDiff(nameStatus, hunks, identity);
    expect(result).toEqual([
      { path: "src/a.ts", status: "modified", hunks: [{ newStart: 1, newLines: 2 }] },
      { path: "src/gone.ts", status: "deleted", hunks: [] },
    ]);
  });

  it("normalises paths via the supplied translator and carries oldPath on renames", () => {
    const nameStatus = [
      { status: "renamed" as const, path: "pkg/new.ts", oldPath: "pkg/old.ts" },
    ];
    const hunks = new Map([["pkg/new.ts", [{ newStart: 3, newLines: 1 }]]]);
    // Simulate a repo-root one level above cwd: strip a leading "pkg/".
    const translate = (p: string): string => p.replace(/^pkg\//, "");
    const result = combineDiff(nameStatus, hunks, translate);
    expect(result).toEqual([
      {
        path: "new.ts",
        status: "renamed",
        oldPath: "old.ts",
        hunks: [{ newStart: 3, newLines: 1 }],
      },
    ]);
  });
});
