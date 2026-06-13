import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadCSharpProjectConfig } from "./language-config.js";
import * as fc from "fast-check";

// Mock node:fs/promises so tests never touch the real filesystem
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

import { readFile, readdir } from "node:fs/promises";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockReaddir = readdir as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeDirent = { name: string; isDirectory(): boolean; isFile(): boolean };

function makeDir(name: string): FakeDirent {
  return { name, isDirectory: () => true, isFile: () => false };
}

function makeFile(name: string): FakeDirent {
  return { name, isDirectory: () => false, isFile: () => true };
}

function makeCsproj(rootNamespace?: string): string {
  if (rootNamespace === undefined) {
    return `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup></PropertyGroup></Project>`;
  }
  return `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><RootNamespace>${rootNamespace}</RootNamespace></PropertyGroup></Project>`;
}

// ---------------------------------------------------------------------------
// loadCSharpProjectConfig — unit tests
// ---------------------------------------------------------------------------

describe("loadCSharpProjectConfig", () => {
  it("extracts <RootNamespace> from a .csproj file", async () => {
    mockReaddir.mockResolvedValueOnce([makeFile("MyApp.csproj")]);
    mockReadFile.mockResolvedValueOnce(makeCsproj("MyApp.Core"));

    const result = await loadCSharpProjectConfig("/repo");

    expect(result).toHaveLength(1);
    expect(result[0]!.rootNamespace).toBe("MyApp.Core");
  });

  it("falls back to filename without extension when <RootNamespace> is absent", async () => {
    mockReaddir.mockResolvedValueOnce([makeFile("MyProject.csproj")]);
    mockReadFile.mockResolvedValueOnce(makeCsproj());

    const result = await loadCSharpProjectConfig("/repo");

    expect(result).toHaveLength(1);
    expect(result[0]!.rootNamespace).toBe("MyProject");
  });

  it("projectDir uses forward slashes for nested paths", async () => {
    // Root dir has a subdirectory "src"
    mockReaddir
      .mockResolvedValueOnce([makeDir("src")])           // /repo
      .mockResolvedValueOnce([makeFile("App.csproj")]);  // /repo/src
    mockReadFile.mockResolvedValueOnce(makeCsproj("App"));

    const result = await loadCSharpProjectConfig("/repo");

    expect(result).toHaveLength(1);
    expect(result[0]!.projectDir).toBe("src");
    expect(result[0]!.projectDir).not.toContain("\\");
  });

  it("BFS skips node_modules, .git, bin, obj directories", async () => {
    mockReaddir.mockResolvedValueOnce([
      makeDir("node_modules"),
      makeDir(".git"),
      makeDir("bin"),
      makeDir("obj"),
      makeFile("App.csproj"),
    ]);
    mockReadFile.mockResolvedValueOnce(makeCsproj("App"));

    const result = await loadCSharpProjectConfig("/repo");

    // readdir should only be called once (root), skipped dirs not visited
    expect(mockReaddir).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it("BFS stops at MAX_DEPTH = 5", async () => {
    // Build a chain of 7 nested directories: depth 0..6
    // Each level has one subdir and no .csproj
    // At depth 5 we should stop enqueuing further
    mockReaddir
      .mockResolvedValueOnce([makeDir("d1")])   // depth 0 → enqueue d1 at depth 1
      .mockResolvedValueOnce([makeDir("d2")])   // depth 1 → enqueue d2 at depth 2
      .mockResolvedValueOnce([makeDir("d3")])   // depth 2 → enqueue d3 at depth 3
      .mockResolvedValueOnce([makeDir("d4")])   // depth 3 → enqueue d4 at depth 4
      .mockResolvedValueOnce([makeDir("d5")])   // depth 4 → enqueue d5 at depth 5
      .mockResolvedValueOnce([makeDir("d6")])   // depth 5 → should NOT enqueue d6
      .mockResolvedValueOnce([]);               // depth 6 — should never be reached

    await loadCSharpProjectConfig("/repo");

    // Depths 0-5 visited = 6 readdir calls; depth 6 never visited
    expect(mockReaddir).toHaveBeenCalledTimes(6);
  });

  it("BFS stops at MAX_DIRS = 100", async () => {
    // Root has 200 subdirectories (all at depth 1, no further nesting)
    // BFS should visit root (1) + up to 99 subdirs = 100 total
    const manyDirs = Array.from({ length: 200 }, (_, i) => makeDir(`sub${i}`));
    mockReaddir.mockResolvedValueOnce(manyDirs); // root: enqueues 200 subdirs
    // Each subdir returns empty (no further nesting)
    mockReaddir.mockResolvedValue([]);

    await loadCSharpProjectConfig("/repo");

    // root (1) + 99 subdirs = 100 total readdir calls
    expect(mockReaddir).toHaveBeenCalledTimes(100);
  });

  it("returns [] when no .csproj files found", async () => {
    mockReaddir.mockResolvedValueOnce([makeFile("README.md"), makeFile("package.json")]);

    const result = await loadCSharpProjectConfig("/repo");

    expect(result).toEqual([]);
  });

  it("skips unreadable .csproj files and continues", async () => {
    mockReaddir.mockResolvedValueOnce([
      makeFile("Bad.csproj"),
      makeFile("Good.csproj"),
    ]);
    mockReadFile
      .mockRejectedValueOnce(new Error("EACCES: permission denied"))
      .mockResolvedValueOnce(makeCsproj("Good.Namespace"));

    const result = await loadCSharpProjectConfig("/repo");

    expect(result).toHaveLength(1);
    expect(result[0]!.rootNamespace).toBe("Good.Namespace");
  });

  it("never throws even when readdir rejects", async () => {
    mockReaddir.mockRejectedValue(new Error("EACCES: permission denied"));

    await expect(loadCSharpProjectConfig("/repo")).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests — loadCSharpProjectConfig
// ---------------------------------------------------------------------------

describe("loadCSharpProjectConfig — property tests", () => {
  /**
   * **Validates: Requirements 4.6**
   * Property 6: projectDir never contains `\` for any result
   */
  it("Property 6: projectDir never contains backslash for any result", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a list of directory path segments (no backslashes in names)
        fc.array(
          fc.stringMatching(/^[a-zA-Z0-9_-]+$/),
          { minLength: 0, maxLength: 4 },
        ),
        fc.string({ minLength: 1 }).filter((s) => /^[a-zA-Z0-9_]+$/.test(s)),
        async (pathSegments, namespace) => {
          mockReadFile.mockReset();
          mockReaddir.mockReset();

          // Build a chain of readdir mocks: each segment is a subdir
          // Final level has a .csproj file
          for (let i = 0; i < pathSegments.length; i++) {
            mockReaddir.mockResolvedValueOnce([makeDir(pathSegments[i]!)]);
          }
          // Final directory has a .csproj
          mockReaddir.mockResolvedValueOnce([makeFile("App.csproj")]);
          mockReadFile.mockResolvedValueOnce(makeCsproj(namespace));

          const result = await loadCSharpProjectConfig("/repo");

          for (const entry of result) {
            expect(entry.projectDir).not.toContain("\\");
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
