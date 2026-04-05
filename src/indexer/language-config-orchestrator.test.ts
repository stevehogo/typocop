import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

import { loadLanguageConfigs } from "./language-config.js";

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// loadLanguageConfigs — unit tests
// ---------------------------------------------------------------------------

describe("loadLanguageConfigs", () => {
  it("returns an object with all five keys when all loaders succeed", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const mockReadFile = readFile as ReturnType<typeof vi.fn>;
    const mockReaddir = readdir as ReturnType<typeof vi.fn>;

    // tsconfig.json with paths
    mockReadFile.mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.endsWith("tsconfig.json")) {
        return Promise.resolve(
          JSON.stringify({ compilerOptions: { paths: { "@app/*": ["src/*"] } } })
        );
      }
      if (p.endsWith("composer.json")) {
        return Promise.resolve(
          JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } })
        );
      }
      if (p.endsWith("go.mod")) {
        return Promise.resolve("module github.com/acme/service\n");
      }
      return Promise.reject(new Error("ENOENT"));
    });

    mockReaddir.mockResolvedValue([]);

    const result = await loadLanguageConfigs("/repo");

    expect(result).toHaveProperty("tsconfig");
    expect(result).toHaveProperty("composer");
    expect(result).toHaveProperty("goModule");
    expect(result).toHaveProperty("csharp");
    expect(result).toHaveProperty("swift");
  });

  it("csharp is always an array (never null) when all loaders succeed", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const mockReadFile = readFile as ReturnType<typeof vi.fn>;
    const mockReaddir = readdir as ReturnType<typeof vi.fn>;

    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockReaddir.mockResolvedValue([]);

    const result = await loadLanguageConfigs("/repo");

    expect(Array.isArray(result.csharp)).toBe(true);
  });

  it("csharp is always an array (never null) when all loaders fail", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const mockReadFile = readFile as ReturnType<typeof vi.fn>;
    const mockReaddir = readdir as ReturnType<typeof vi.fn>;

    mockReadFile.mockRejectedValue(new Error("EACCES: permission denied"));
    mockReaddir.mockRejectedValue(new Error("EACCES: permission denied"));

    const result = await loadLanguageConfigs("/repo");

    expect(Array.isArray(result.csharp)).toBe(true);
  });

  it("never throws when given a non-existent path (all readFile/readdir reject)", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const mockReadFile = readFile as ReturnType<typeof vi.fn>;
    const mockReaddir = readdir as ReturnType<typeof vi.fn>;

    mockReadFile.mockRejectedValue(new Error("ENOENT: no such file or directory"));
    mockReaddir.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    await expect(loadLanguageConfigs("/nonexistent/path")).resolves.toBeDefined();
  });

  it("never throws when given an empty string as repoRoot", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const mockReadFile = readFile as ReturnType<typeof vi.fn>;
    const mockReaddir = readdir as ReturnType<typeof vi.fn>;

    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    await expect(loadLanguageConfigs("")).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Property-based tests — loadLanguageConfigs
// ---------------------------------------------------------------------------

describe("loadLanguageConfigs — property tests", () => {
  /**
   * **Validates: Requirements 6.4**
   * Property 7: `loadLanguageConfigs` never throws for any string input
   */
  it("Property 7: never throws for any string input", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const mockReadFile = readFile as ReturnType<typeof vi.fn>;
    const mockReaddir = readdir as ReturnType<typeof vi.fn>;

    await fc.assert(
      fc.asyncProperty(fc.string(), async (repoRoot) => {
        mockReadFile.mockReset();
        mockReaddir.mockReset();
        mockReadFile.mockRejectedValue(new Error("ENOENT"));
        mockReaddir.mockRejectedValue(new Error("ENOENT"));

        await expect(loadLanguageConfigs(repoRoot)).resolves.toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 6.2, 6.3**
   * Property 8: result always has all five keys and `csharp` is always an array
   */
  it("Property 8: result always has all five keys and csharp is always an array", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const mockReadFile = readFile as ReturnType<typeof vi.fn>;
    const mockReaddir = readdir as ReturnType<typeof vi.fn>;

    await fc.assert(
      fc.asyncProperty(fc.string(), async (repoRoot) => {
        mockReadFile.mockReset();
        mockReaddir.mockReset();
        mockReadFile.mockRejectedValue(new Error("ENOENT"));
        mockReaddir.mockRejectedValue(new Error("ENOENT"));

        const result = await loadLanguageConfigs(repoRoot);

        expect(result).toHaveProperty("tsconfig");
        expect(result).toHaveProperty("composer");
        expect(result).toHaveProperty("goModule");
        expect(result).toHaveProperty("csharp");
        expect(result).toHaveProperty("swift");
        expect(Array.isArray(result.csharp)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
