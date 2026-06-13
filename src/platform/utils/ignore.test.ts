import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  shouldIgnorePath,
  DEFAULT_IGNORE_LIST,
  IGNORED_EXTENSIONS,
  IGNORED_FILES,
} from "./ignore.js";

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe("shouldIgnorePath", () => {
  // 2.1 Directory segment matching
  describe("directory segment matching", () => {
    it("ignores node_modules/lodash/index.js", () => {
      expect(shouldIgnorePath("node_modules/lodash/index.js")).toBe(true);
    });

    it("ignores dist/app.js", () => {
      expect(shouldIgnorePath("dist/app.js")).toBe(true);
    });

    it("ignores .git/config", () => {
      expect(shouldIgnorePath(".git/config")).toBe(true);
    });

    it("ignores __tests__ directory segment", () => {
      expect(shouldIgnorePath("__tests__/foo.test.ts")).toBe(true);
    });

    it("ignores coverage/lcov.info", () => {
      expect(shouldIgnorePath("coverage/lcov.info")).toBe(true);
    });
  });

  // 2.2 Nested segment matching
  describe("nested segment matching", () => {
    it("ignores src/node_modules/foo.ts", () => {
      expect(shouldIgnorePath("src/node_modules/foo.ts")).toBe(true);
    });

    it("ignores deeply nested ignored segment", () => {
      expect(shouldIgnorePath("a/b/c/dist/output.js")).toBe(true);
    });
  });

  // 2.3 Exact filename matching
  describe("exact filename matching", () => {
    it("ignores package-lock.json at root", () => {
      expect(shouldIgnorePath("package-lock.json")).toBe(true);
    });

    it("ignores package-lock.json in subdirectory", () => {
      expect(shouldIgnorePath("src/package-lock.json")).toBe(true);
    });

    it("ignores yarn.lock", () => {
      expect(shouldIgnorePath("yarn.lock")).toBe(true);
    });

    it("ignores .env", () => {
      expect(shouldIgnorePath(".env")).toBe(true);
    });

    it("ignores .gitignore", () => {
      expect(shouldIgnorePath(".gitignore")).toBe(true);
    });
  });

  // 2.4 Single extension matching
  describe("single extension matching", () => {
    it("ignores assets/logo.png", () => {
      expect(shouldIgnorePath("assets/logo.png")).toBe(true);
    });

    it("ignores dist/app.wasm", () => {
      expect(shouldIgnorePath("dist/app.wasm")).toBe(true);
    });

    it("ignores image.jpg", () => {
      expect(shouldIgnorePath("image.jpg")).toBe(true);
    });

    it("ignores archive.zip", () => {
      expect(shouldIgnorePath("archive.zip")).toBe(true);
    });
  });

  // 2.5 Compound extension matching
  describe("compound extension matching", () => {
    it("ignores app.min.js", () => {
      expect(shouldIgnorePath("app.min.js")).toBe(true);
    });

    it("ignores vendor.bundle.js", () => {
      expect(shouldIgnorePath("vendor.bundle.js")).toBe(true);
    });

    it("ignores 0.chunk.js", () => {
      expect(shouldIgnorePath("0.chunk.js")).toBe(true);
    });

    it("ignores styles.min.css", () => {
      expect(shouldIgnorePath("styles.min.css")).toBe(true);
    });
  });

  // 2.6 Generated pattern matching
  describe("generated pattern matching", () => {
    it("ignores src/types/api.d.ts", () => {
      expect(shouldIgnorePath("src/types/api.d.ts")).toBe(true);
    });

    it("ignores src/api.generated.ts", () => {
      expect(shouldIgnorePath("src/api.generated.ts")).toBe(true);
    });

    it("ignores foo.bundle.js", () => {
      expect(shouldIgnorePath("foo.bundle.js")).toBe(true);
    });

    it("ignores foo.chunk.ts", () => {
      expect(shouldIgnorePath("foo.chunk.ts")).toBe(true);
    });
  });

  // 2.7 Allowed source files
  describe("allowed source files", () => {
    it("allows src/index.ts", () => {
      expect(shouldIgnorePath("src/index.ts")).toBe(false);
    });

    it("allows src/utils/ignore.ts", () => {
      expect(shouldIgnorePath("src/utils/ignore.ts")).toBe(false);
    });

    it("allows README.md", () => {
      expect(shouldIgnorePath("README.md")).toBe(false);
    });

    it("allows src/parser/index.ts", () => {
      expect(shouldIgnorePath("src/parser/index.ts")).toBe(false);
    });
  });

  // 2.8 Windows path normalization
  describe("Windows path normalization", () => {
    it("ignores node_modules\\\\lodash\\\\index.js", () => {
      expect(shouldIgnorePath("node_modules\\lodash\\index.js")).toBe(true);
    });

    it("ignores dist\\\\app.js with backslashes", () => {
      expect(shouldIgnorePath("dist\\app.js")).toBe(true);
    });
  });

  // 2.9 Case-insensitive filename matching
  describe("case-insensitive filename matching", () => {
    it("ignores PACKAGE-LOCK.JSON (uppercased)", () => {
      expect(shouldIgnorePath("PACKAGE-LOCK.JSON")).toBe(true);
    });

    it("ignores Thumbs.db with mixed case", () => {
      expect(shouldIgnorePath("THUMBS.DB")).toBe(true);
    });
  });
});

// ─── Exported constants ───────────────────────────────────────────────────────

describe("exported constants", () => {
  it("DEFAULT_IGNORE_LIST is a ReadonlySet containing node_modules", () => {
    expect(DEFAULT_IGNORE_LIST.has("node_modules")).toBe(true);
  });

  it("DEFAULT_IGNORE_LIST contains __tests__", () => {
    expect(DEFAULT_IGNORE_LIST.has("__tests__")).toBe(true);
  });

  it("IGNORED_EXTENSIONS is a ReadonlySet containing .png", () => {
    expect(IGNORED_EXTENSIONS.has(".png")).toBe(true);
  });

  it("IGNORED_FILES is a ReadonlySet containing package-lock.json", () => {
    expect(IGNORED_FILES.has("package-lock.json")).toBe(true);
  });
});

// ─── Property-Based Tests ─────────────────────────────────────────────────────

describe("property-based tests", () => {
  const safeSegment = fc
    .string({ minLength: 1 })
    .filter((s) => !s.includes("/") && !s.includes("\\"));

  // 3.1 Property 1: any path with a DEFAULT_IGNORE_LIST segment → always true
  it("Property 1: any path containing a DEFAULT_IGNORE_LIST segment is ignored", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DEFAULT_IGNORE_LIST),
        fc.array(safeSegment),
        fc.array(safeSegment),
        safeSegment,
        (ignoredSegment, prefix, suffix, filename) => {
          const p = [...prefix, ignoredSegment, ...suffix, filename].join("/");
          return shouldIgnorePath(p) === true;
        }
      ),
      { numRuns: 50 }
    );
  });

  // 3.2 Property 2: any path with an IGNORED_FILES filename → always true
  it("Property 2: any path whose filename is in IGNORED_FILES is ignored", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...IGNORED_FILES),
        fc.array(safeSegment),
        (ignoredFile, dirs) => {
          const p =
            dirs.length > 0 ? `${dirs.join("/")}/${ignoredFile}` : ignoredFile;
          return shouldIgnorePath(p) === true;
        }
      ),
      { numRuns: 50 }
    );
  });

  // 3.3 Property 3: any path with a single-dot IGNORED_EXTENSIONS extension → always true
  it("Property 3: any path with a single-dot extension in IGNORED_EXTENSIONS is ignored", () => {
    const singleDotExts = [...IGNORED_EXTENSIONS].filter(
      (e) => (e.match(/\./g) ?? []).length === 1
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...singleDotExts),
        fc.string({ minLength: 1 }).filter((s) => !s.includes("/")),
        (ext, basename) => {
          return shouldIgnorePath(`src/${basename}${ext}`) === true;
        }
      ),
      { numRuns: 50 }
    );
  });

  // 3.4 Property 4: compound extensions (.min.js, .bundle.js, .chunk.js, .min.css) → always true
  it("Property 4: compound extensions are always ignored", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(".min.js", ".bundle.js", ".chunk.js", ".min.css"),
        fc.string({ minLength: 1 }).filter((s) => !s.includes(".")),
        (compoundExt, basename) => {
          return shouldIgnorePath(`src/${basename}${compoundExt}`) === true;
        }
      ),
      { numRuns: 50 }
    );
  });

  // 3.5 Property 5: any path ending in .d.ts → always true
  it("Property 5: any path ending in .d.ts is ignored", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !s.includes("/")),
        (basename) => {
          return shouldIgnorePath(`src/${basename}.d.ts`) === true;
        }
      ),
      { numRuns: 50 }
    );
  });

  // 3.6 Property 6: src/<clean-name>.ts paths → always false
  it("Property 6: clean src/<name>.ts paths are never ignored", () => {
    const ignoredSegments = new Set(DEFAULT_IGNORE_LIST);
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1 })
          .filter(
            (s) =>
              !s.includes("/") &&
              !s.includes(".") &&
              !s.includes("\\") &&
              !ignoredSegments.has(s)
          ),
        (name) => {
          return shouldIgnorePath(`src/${name}.ts`) === false;
        }
      ),
      { numRuns: 50 }
    );
  });

  // 3.7 Property 7: shouldIgnorePath is pure (same input → same output)
  it("Property 7: shouldIgnorePath is pure — same input always returns same output", () => {
    fc.assert(
      fc.property(fc.string(), (p) => {
        return shouldIgnorePath(p) === shouldIgnorePath(p);
      }),
      { numRuns: 100 }
    );
  });

  // 3.8 Property 8: Windows path normalization is transparent (/ vs \\ gives same result)
  it("Property 8: Windows path normalization is transparent", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes("\\")),
        (posixPath) => {
          const windowsPath = posixPath.replace(/\//g, "\\");
          return shouldIgnorePath(posixPath) === shouldIgnorePath(windowsPath);
        }
      ),
      { numRuns: 100 }
    );
  });

  // 3.9 Property 9: any path with .generated. in filename → always true
  it("Property 9: any path with .generated. in filename is ignored", () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1 })
          .filter((s) => !s.includes("/") && !s.includes("\\")),
        fc
          .string({ minLength: 1 })
          .filter((s) => !s.includes("/") && !s.includes("\\")),
        (prefix, suffix) => {
          return (
            shouldIgnorePath(`src/${prefix}.generated.${suffix}`) === true
          );
        }
      ),
      { numRuns: 50 }
    );
  });
});
