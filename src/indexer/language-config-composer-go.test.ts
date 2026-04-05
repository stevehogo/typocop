import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadComposerConfig, loadGoModulePath } from "./language-config.js";
import * as fc from "fast-check";

// Mock node:fs/promises so tests never touch the real filesystem
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

import { readFile } from "node:fs/promises";

const mockReadFile = readFile as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeComposer(
  autoload?: Record<string, string>,
  autoloadDev?: Record<string, string>,
): string {
  return JSON.stringify({
    ...(autoload !== undefined ? { autoload: { "psr-4": autoload } } : {}),
    ...(autoloadDev !== undefined ? { "autoload-dev": { "psr-4": autoloadDev } } : {}),
  });
}

// ---------------------------------------------------------------------------
// loadComposerConfig — unit tests
// ---------------------------------------------------------------------------

describe("loadComposerConfig", () => {
  describe("merging autoload and autoload-dev", () => {
    it("returns psr4 entries from autoload only when autoload-dev is absent", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeComposer({ "App\\": "app/" }),
      );

      const result = await loadComposerConfig("/repo");

      expect(result).not.toBeNull();
      expect(result!.psr4.get("App")).toBe("app");
    });

    it("returns psr4 entries from autoload-dev only when autoload is absent", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeComposer(undefined, { "Tests\\": "tests/" }),
      );

      const result = await loadComposerConfig("/repo");

      expect(result).not.toBeNull();
      expect(result!.psr4.get("Tests")).toBe("tests");
    });

    it("merges both autoload and autoload-dev sections", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeComposer(
          { "App\\": "app/", "Domain\\": "src/Domain/" },
          { "Tests\\": "tests/" },
        ),
      );

      const result = await loadComposerConfig("/repo");

      expect(result).not.toBeNull();
      expect(result!.psr4.size).toBe(3);
      expect(result!.psr4.get("App")).toBe("app");
      expect(result!.psr4.get("Domain")).toBe("src/Domain");
      expect(result!.psr4.get("Tests")).toBe("tests");
    });

    it("dev entries override prod entries for the same namespace key", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeComposer(
          { "App\\": "app/" },
          { "App\\": "app-dev/" }, // dev overrides prod
        ),
      );

      const result = await loadComposerConfig("/repo");

      expect(result).not.toBeNull();
      expect(result!.psr4.get("App")).toBe("app-dev");
    });
  });

  describe("namespace key normalisation", () => {
    it("strips trailing backslash from namespace keys", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeComposer({ "App\\": "app/" }),
      );

      const result = await loadComposerConfig("/repo");

      expect(result!.psr4.has("App\\")).toBe(false);
      expect(result!.psr4.has("App")).toBe(true);
    });

    it("leaves namespace keys without trailing backslash unchanged", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeComposer({ "App": "app/" }),
      );

      const result = await loadComposerConfig("/repo");

      expect(result!.psr4.has("App")).toBe(true);
    });
  });

  describe("directory value normalisation", () => {
    it("strips trailing slash from directory values", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeComposer({ "App\\": "app/" }),
      );

      const result = await loadComposerConfig("/repo");

      expect(result!.psr4.get("App")).toBe("app");
    });

    it("converts backslashes to forward slashes in directory values", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeComposer({ "App\\": "src\\App\\" }),
      );

      const result = await loadComposerConfig("/repo");

      expect(result!.psr4.get("App")).toBe("src/App");
    });

    it("leaves directory values without trailing slash unchanged", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeComposer({ "App\\": "app" }),
      );

      const result = await loadComposerConfig("/repo");

      expect(result!.psr4.get("App")).toBe("app");
    });
  });

  describe("null return cases", () => {
    it("returns null when composer.json is absent", async () => {
      mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

      const result = await loadComposerConfig("/repo");

      expect(result).toBeNull();
    });

    it("returns null when composer.json contains invalid JSON", async () => {
      mockReadFile.mockResolvedValueOnce("{ not valid json }");

      const result = await loadComposerConfig("/repo");

      expect(result).toBeNull();
    });

    it("returns null when composer.json has no psr-4 sections", async () => {
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify({ name: "vendor/package", require: {} }),
      );

      const result = await loadComposerConfig("/repo");

      expect(result).toBeNull();
    });

    it("never throws even when readFile rejects with unexpected error", async () => {
      mockReadFile.mockRejectedValueOnce(new Error("EACCES: permission denied"));

      await expect(loadComposerConfig("/repo")).resolves.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Property-based tests — loadComposerConfig
// ---------------------------------------------------------------------------

describe("loadComposerConfig — property tests", () => {
  it("Property 3: PSR-4 namespace keys never end with '\\' after normalisation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.oneof(
            fc.string({ minLength: 1 }).map((s) => `${s}\\`),
            fc.string({ minLength: 1 }),
          ),
          fc.string({ minLength: 1 }),
          { minKeys: 1, maxKeys: 10 },
        ),
        async (psr4) => {
          mockReadFile.mockReset();
          mockReadFile.mockResolvedValueOnce(
            JSON.stringify({ autoload: { "psr-4": psr4 } }),
          );

          const result = await loadComposerConfig("/repo");

          if (result !== null) {
            for (const key of result.psr4.keys()) {
              expect(key.endsWith("\\")).toBe(false);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 4: PSR-4 directory values never end with '/' after normalisation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.string({ minLength: 1 }),
          fc.oneof(
            fc.string({ minLength: 1 }).map((s) => `${s}/`),
            fc.string({ minLength: 1 }),
          ),
          { minKeys: 1, maxKeys: 10 },
        ),
        async (psr4) => {
          mockReadFile.mockReset();
          mockReadFile.mockResolvedValueOnce(
            JSON.stringify({ autoload: { "psr-4": psr4 } }),
          );

          const result = await loadComposerConfig("/repo");

          if (result !== null) {
            for (const value of result.psr4.values()) {
              expect(value.endsWith("/")).toBe(false);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// loadGoModulePath — unit tests
// ---------------------------------------------------------------------------

describe("loadGoModulePath", () => {
  it("extracts module path from a valid go.mod", async () => {
    mockReadFile.mockResolvedValueOnce("module github.com/acme/service\n\ngo 1.21\n");

    const result = await loadGoModulePath("/repo");

    expect(result).not.toBeNull();
    expect(result!.modulePath).toBe("github.com/acme/service");
  });

  it("extracts module path when module directive is not on the first line", async () => {
    mockReadFile.mockResolvedValueOnce("// comment\nmodule github.com/acme/other\n");

    const result = await loadGoModulePath("/repo");

    expect(result).not.toBeNull();
    expect(result!.modulePath).toBe("github.com/acme/other");
  });

  it("returns null when go.mod is absent (readFile rejects)", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT"));

    const result = await loadGoModulePath("/repo");

    expect(result).toBeNull();
  });

  it("returns null when go.mod has no module directive", async () => {
    mockReadFile.mockResolvedValueOnce("go 1.21\n\nrequire (\n  github.com/some/dep v1.0.0\n)\n");

    const result = await loadGoModulePath("/repo");

    expect(result).toBeNull();
  });

  it("never throws on unexpected errors", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("EACCES: permission denied"));

    await expect(loadGoModulePath("/repo")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property-based tests — loadGoModulePath
// ---------------------------------------------------------------------------

describe("loadGoModulePath — property tests", () => {
  /**
   * **Validates: Requirements 3.3**
   * Property 5: modulePath is non-empty when loader returns non-null
   */
  it("Property 5: modulePath is non-empty when loader returns non-null", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate valid go.mod content with a module directive
        fc.string({ minLength: 1 }).filter((s) => /^\S+$/.test(s)),
        async (modulePath) => {
          mockReadFile.mockReset();
          mockReadFile.mockResolvedValueOnce(`module ${modulePath}\n\ngo 1.21\n`);

          const result = await loadGoModulePath("/repo");

          if (result !== null) {
            expect(result.modulePath.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
