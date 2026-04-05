import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadTsconfigPaths } from "./language-config.js";

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

function makeTsconfig(paths: Record<string, string[]>, baseUrl?: string): string {
  return JSON.stringify({
    compilerOptions: {
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      paths,
    },
  });
}

// ---------------------------------------------------------------------------
// loadTsconfigPaths
// ---------------------------------------------------------------------------

describe("loadTsconfigPaths", () => {
  describe("JSON comment stripping", () => {
    it("parses tsconfig with single-line // comments", async () => {
      const raw = `{
        // this is a comment
        "compilerOptions": {
          "paths": {
            "@app/*": ["src/*"] // inline comment
          }
        }
      }`;
      mockReadFile.mockResolvedValueOnce(raw);

      const result = await loadTsconfigPaths("/repo");

      expect(result).not.toBeNull();
      expect(result!.aliases.get("@app/")).toBe("src/");
    });

    it("parses tsconfig with multi-line /* */ comments", async () => {
      const raw = `{
        /* block comment
           spanning lines */
        "compilerOptions": {
          "paths": {
            "@lib/*": ["lib/*"]
          }
        }
      }`;
      mockReadFile.mockResolvedValueOnce(raw);

      const result = await loadTsconfigPaths("/repo");

      expect(result).not.toBeNull();
      expect(result!.aliases.get("@lib/")).toBe("lib/");
    });

    it("parses tsconfig with both comment styles present", async () => {
      const raw = `{
        /* top comment */
        "compilerOptions": {
          // paths section
          "paths": {
            "@utils": ["src/utils/index.ts"]
          }
          /* end of compilerOptions */
        }
      }`;
      mockReadFile.mockResolvedValueOnce(raw);

      const result = await loadTsconfigPaths("/repo");

      expect(result).not.toBeNull();
      expect(result!.aliases.get("@utils")).toBe("src/utils/index.ts");
    });
  });

  describe("glob normalisation", () => {
    it("strips trailing * from alias keys ending with /*", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeTsconfig({ "@app/*": ["src/app/*"] })
      );

      const result = await loadTsconfigPaths("/repo");

      expect(result).not.toBeNull();
      expect(result!.aliases.has("@app/*")).toBe(false);
      expect(result!.aliases.has("@app/")).toBe(true);
    });

    it("strips trailing * from target values ending with /*", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeTsconfig({ "@app/*": ["src/app/*"] })
      );

      const result = await loadTsconfigPaths("/repo");

      expect(result!.aliases.get("@app/")).toBe("src/app/");
    });

    it("leaves alias keys that do not end with * unchanged", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeTsconfig({ "@config": ["src/config/index.ts"] })
      );

      const result = await loadTsconfigPaths("/repo");

      expect(result!.aliases.has("@config")).toBe(true);
    });

    it("leaves target values that do not end with * unchanged", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeTsconfig({ "@config": ["src/config/index.ts"] })
      );

      const result = await loadTsconfigPaths("/repo");

      expect(result!.aliases.get("@config")).toBe("src/config/index.ts");
    });

    it("normalises multiple aliases in one tsconfig", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeTsconfig({
          "@app/*": ["src/app/*"],
          "@lib/*": ["src/lib/*"],
          "@root": ["src/index.ts"],
        })
      );

      const result = await loadTsconfigPaths("/repo");

      expect(result!.aliases.get("@app/")).toBe("src/app/");
      expect(result!.aliases.get("@lib/")).toBe("src/lib/");
      expect(result!.aliases.get("@root")).toBe("src/index.ts");
    });
  });

  describe("baseUrl defaulting", () => {
    it("uses baseUrl from compilerOptions when present", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeTsconfig({ "@app/*": ["src/*"] }, "src")
      );

      const result = await loadTsconfigPaths("/repo");

      expect(result!.baseUrl).toBe("src");
    });

    it("defaults baseUrl to '.' when absent", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeTsconfig({ "@app/*": ["src/*"] })
      );

      const result = await loadTsconfigPaths("/repo");

      expect(result!.baseUrl).toBe(".");
    });
  });

  describe("candidate fallback order", () => {
    it("returns result from tsconfig.json when it has paths", async () => {
      mockReadFile.mockResolvedValueOnce(
        makeTsconfig({ "@app/*": ["src/*"] })
      );

      const result = await loadTsconfigPaths("/repo");

      // readFile called once — stopped at first candidate
      expect(mockReadFile).toHaveBeenCalledTimes(1);
      expect(mockReadFile).toHaveBeenCalledWith(
        expect.stringContaining("tsconfig.json"),
        "utf-8"
      );
      expect(result).not.toBeNull();
    });

    it("falls back to tsconfig.app.json when tsconfig.json is absent", async () => {
      mockReadFile
        .mockRejectedValueOnce(new Error("ENOENT")) // tsconfig.json missing
        .mockResolvedValueOnce(makeTsconfig({ "@app/*": ["src/*"] })); // tsconfig.app.json

      const result = await loadTsconfigPaths("/repo");

      expect(result).not.toBeNull();
      expect(mockReadFile).toHaveBeenCalledTimes(2);
      expect(mockReadFile).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("tsconfig.app.json"),
        "utf-8"
      );
    });

    it("falls back to tsconfig.base.json when first two are absent", async () => {
      mockReadFile
        .mockRejectedValueOnce(new Error("ENOENT")) // tsconfig.json
        .mockRejectedValueOnce(new Error("ENOENT")) // tsconfig.app.json
        .mockResolvedValueOnce(makeTsconfig({ "@base/*": ["packages/*"] }));

      const result = await loadTsconfigPaths("/repo");

      expect(result).not.toBeNull();
      expect(result!.aliases.get("@base/")).toBe("packages/");
      expect(mockReadFile).toHaveBeenCalledTimes(3);
    });

    it("skips a candidate that has no paths and tries the next", async () => {
      const noPathsTsconfig = JSON.stringify({ compilerOptions: {} });
      mockReadFile
        .mockResolvedValueOnce(noPathsTsconfig) // tsconfig.json — no paths
        .mockResolvedValueOnce(makeTsconfig({ "@app/*": ["src/*"] })); // tsconfig.app.json

      const result = await loadTsconfigPaths("/repo");

      expect(result).not.toBeNull();
      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });

    it("skips a candidate with an empty paths map and tries the next", async () => {
      const emptyPaths = makeTsconfig({});
      mockReadFile
        .mockResolvedValueOnce(emptyPaths)
        .mockResolvedValueOnce(makeTsconfig({ "@app/*": ["src/*"] }));

      const result = await loadTsconfigPaths("/repo");

      expect(result).not.toBeNull();
      expect(mockReadFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("null return cases", () => {
    it("returns null when all three candidates are absent", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));

      const result = await loadTsconfigPaths("/repo");

      expect(result).toBeNull();
      expect(mockReadFile).toHaveBeenCalledTimes(3);
    });

    it("returns null when all candidates exist but none has paths", async () => {
      const noPathsTsconfig = JSON.stringify({ compilerOptions: {} });
      mockReadFile.mockResolvedValue(noPathsTsconfig);

      const result = await loadTsconfigPaths("/repo");

      expect(result).toBeNull();
    });

    it("returns null when tsconfig has invalid JSON after comment stripping", async () => {
      mockReadFile.mockResolvedValue("{ this is not valid json }");

      const result = await loadTsconfigPaths("/repo");

      expect(result).toBeNull();
    });

    it("never throws even when readFile rejects with unexpected error", async () => {
      mockReadFile.mockRejectedValue(new Error("EACCES: permission denied"));

      await expect(loadTsconfigPaths("/repo")).resolves.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Property-based tests — loadTsconfigPaths
// ---------------------------------------------------------------------------

import * as fc from "fast-check";

describe("loadTsconfigPaths — property tests", () => {
  it("Property 1: alias keys never end with '*' after normalisation", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate arbitrary alias key/value pairs
        fc.dictionary(
          fc.oneof(
            fc.string({ minLength: 1 }).map((s) => `@${s}/*`),
            fc.string({ minLength: 1 }).map((s) => `@${s}`),
          ),
          fc.array(
            fc.oneof(
              fc.string({ minLength: 1 }).map((s) => `${s}/*`),
              fc.string({ minLength: 1 }),
            ),
            { minLength: 1, maxLength: 3 },
          ),
          { minKeys: 1, maxKeys: 10 },
        ),
        async (paths) => {
          mockReadFile.mockReset();
          mockReadFile.mockResolvedValueOnce(
            JSON.stringify({ compilerOptions: { paths } }),
          );

          const result = await loadTsconfigPaths("/repo");

          if (result !== null) {
            for (const key of result.aliases.keys()) {
              expect(key.endsWith("*")).toBe(false);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
