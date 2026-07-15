/**
 * Wave 1 — import-resolution sub-pass: assert exact map contents.
 *
 * Feeds hand-built `import` hints + a file list + configs into
 * `populateImportMaps` and asserts the resulting `importMap` / `packageMap` /
 * `namedImportMap` match a hand-built expectation, including the Go dir-suffix
 * round-trip through `isFileInPackageDir`.
 */
import { describe, it, expect } from "vitest";
import type { LanguageConfigs } from "../language-config.js";
import { createResolutionContext } from "./resolution-context.js";
import { isFileInPackageDir } from "./named-binding.js";
import { populateImportMaps, type ImportHintLike } from "./import-resolution-pass.js";

const noConfigs: LanguageConfigs = {
  tsconfig: null,
  composer: null,
  goModule: null,
  csharp: [],
  swift: null,
};

describe("populateImportMaps — file imports (TS)", () => {
  it("writes resolved relative targets into importMap", () => {
    const files = ["src/index.ts", "src/models.ts", "src/util/log.ts"];
    const hints: ImportHintLike[] = [
      { kind: "import", sourceFile: "src/index.ts", targetName: "./models", language: "typescript" },
      { kind: "import", sourceFile: "src/index.ts", targetName: "./util/log", language: "typescript" },
    ];
    const ctx = createResolutionContext();
    populateImportMaps(ctx, hints, files, noConfigs);

    expect([...(ctx.importMap.get("src/index.ts") ?? [])].sort()).toEqual(
      ["src/models.ts", "src/util/log.ts"].sort(),
    );
    expect(ctx.packageMap.size).toBe(0);
    expect(ctx.namedImportMap.size).toBe(0);
  });

  it("external specifiers add nothing", () => {
    const files = ["src/index.ts"];
    const hints: ImportHintLike[] = [
      { kind: "import", sourceFile: "src/index.ts", targetName: "react", language: "typescript" },
    ];
    const ctx = createResolutionContext();
    populateImportMaps(ctx, hints, files, noConfigs);
    expect(ctx.importMap.size).toBe(0);
  });

  it("dedupes repeated specifiers per file (resolves once)", () => {
    const files = ["src/index.ts", "src/models.ts"];
    const hints: ImportHintLike[] = [
      { kind: "import", sourceFile: "src/index.ts", targetName: "./models", language: "typescript" },
      { kind: "import", sourceFile: "src/index.ts", targetName: "./models", language: "typescript" },
    ];
    const ctx = createResolutionContext();
    populateImportMaps(ctx, hints, files, noConfigs);
    expect([...(ctx.importMap.get("src/index.ts") ?? [])]).toEqual(["src/models.ts"]);
  });
});

describe("populateImportMaps — named bindings (single-file only)", () => {
  it("records aliased bindings only when the import resolves to exactly one file", () => {
    const files = ["src/index.ts", "src/models.ts"];
    const hints: ImportHintLike[] = [
      {
        kind: "import",
        sourceFile: "src/index.ts",
        targetName: "./models",
        language: "typescript",
        namedBindings: [
          { local: "U", exported: "User" },
          { local: "Repo", exported: "Repo" },
        ],
      },
    ];
    const ctx = createResolutionContext();
    populateImportMaps(ctx, hints, files, noConfigs);

    const bindings = ctx.namedImportMap.get("src/index.ts");
    expect(bindings?.get("U")).toEqual({ sourcePath: "src/models.ts", exportedName: "User" });
    expect(bindings?.get("Repo")).toEqual({ sourcePath: "src/models.ts", exportedName: "Repo" });
  });

  it("does NOT record bindings for a multi-file (package) resolution", () => {
    const files = ["internal/auth/a.go", "internal/auth/b.go", "cmd/main.go"];
    const configs: LanguageConfigs = { ...noConfigs, goModule: { modulePath: "github.com/org/repo" } };
    const hints: ImportHintLike[] = [
      {
        kind: "import",
        sourceFile: "cmd/main.go",
        targetName: "github.com/org/repo/internal/auth",
        language: "go",
        namedBindings: [{ local: "Svc", exported: "Svc" }],
      },
    ];
    const ctx = createResolutionContext();
    populateImportMaps(ctx, hints, files, configs);
    expect(ctx.namedImportMap.size).toBe(0);
  });
});

describe("populateImportMaps — Go package both-maps + isFileInPackageDir round-trip", () => {
  it("writes the dir suffix to packageMap AND member files to importMap", () => {
    const files = ["internal/auth/service.go", "internal/auth/handler.go", "cmd/main.go"];
    const configs: LanguageConfigs = { ...noConfigs, goModule: { modulePath: "github.com/org/repo" } };
    const hints: ImportHintLike[] = [
      { kind: "import", sourceFile: "cmd/main.go", targetName: "github.com/org/repo/internal/auth", language: "go" },
    ];
    const ctx = createResolutionContext();
    populateImportMaps(ctx, hints, files, configs);

    // packageMap holds the trailing package directory segment.
    const pkg = ctx.packageMap.get("cmd/main.go");
    expect(pkg).toBeDefined();
    expect([...pkg!]).toEqual(["auth"]);

    // importMap holds the member files (Tier 2a backstop).
    expect([...(ctx.importMap.get("cmd/main.go") ?? [])].sort()).toEqual(
      ["internal/auth/service.go", "internal/auth/handler.go"].sort(),
    );

    // Round-trip: the suffix matches the member files via isFileInPackageDir.
    const suffix = [...pkg!][0];
    expect(isFileInPackageDir("internal/auth/service.go", suffix)).toBe(true);
    expect(isFileInPackageDir("internal/auth/handler.go", suffix)).toBe(true);
    expect(isFileInPackageDir("cmd/main.go", suffix)).toBe(false);
  });
});

describe("populateImportMaps — guards", () => {
  it("no-op when allFiles is empty", () => {
    const ctx = createResolutionContext();
    populateImportMaps(
      ctx,
      [{ kind: "import", sourceFile: "src/a.ts", targetName: "./b", language: "typescript" }],
      [],
      noConfigs,
    );
    expect(ctx.importMap.size).toBe(0);
  });

  it("throws under test on a path-convention mismatch (abs vs rel)", () => {
    const ctx = createResolutionContext();
    const hints: ImportHintLike[] = [
      { kind: "import", sourceFile: "/abs/src/index.ts", targetName: "./models", language: "typescript" },
    ];
    // File list uses relative paths; no sampled hint sourceFile present → throw.
    expect(() => populateImportMaps(ctx, hints, ["src/index.ts", "src/models.ts"], noConfigs)).toThrow(
      /Path-convention mismatch/,
    );
  });
});
