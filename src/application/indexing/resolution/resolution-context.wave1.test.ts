/**
 * Wave 1 — tier integration via populateImportMaps (companion to
 * resolution-context.test.ts, which hand-`.set()`s the maps).
 *
 * Plants a NON-UNIQUE symbol name defined in two files, imports ONE of them,
 * and asserts the now-populated maps make Tiers 2a / 2a-named / 2b resolve to
 * the IMPORTED definition (import-scoped) instead of the Tier-3 global
 * first-match.
 */
import { describe, it, expect } from "vitest";
import type { LanguageConfigs } from "../language-config.js";
import { createResolutionContext } from "./resolution-context.js";
import { populateImportMaps, type ImportHintLike } from "./import-resolution-pass.js";

const noConfigs: LanguageConfigs = {
  tsconfig: null,
  composer: null,
  goModule: null,
  csharp: [],
  swift: null,
};

describe("Tier 2a (import-scoped) via populateImportMaps", () => {
  it("resolves a non-unique name to the IMPORTED def, not the global first-match", () => {
    const ctx = createResolutionContext();
    // Two definitions of `User` — wrong.ts is inserted FIRST (would win Tier 3).
    ctx.symbols.add("src/wrong.ts", "User", "sym-wrong", "class");
    ctx.symbols.add("src/right.ts", "User", "sym-right", "class");

    const files = ["src/consumer.ts", "src/wrong.ts", "src/right.ts"];
    const hints: ImportHintLike[] = [
      { kind: "import", sourceFile: "src/consumer.ts", targetName: "./right", language: "typescript" },
    ];
    populateImportMaps(ctx, hints, files, noConfigs);

    const result = ctx.resolve("User", "src/consumer.ts");
    expect(result?.tier).toBe("import-scoped");
    expect(result?.candidates.map((c) => c.nodeId)).toEqual(["sym-right"]);
  });

  it("without the import (no map), the same name falls to Tier 3 global", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/wrong.ts", "User", "sym-wrong", "class");
    ctx.symbols.add("src/right.ts", "User", "sym-right", "class");

    const result = ctx.resolve("User", "src/consumer.ts");
    expect(result?.tier).toBe("global");
    // Tier 3 returns ALL candidates; caller takes [0] = the global first-match.
    expect(result?.candidates[0].nodeId).toBe("sym-wrong");
  });
});

describe("Tier 2a-named via populateImportMaps", () => {
  it("resolves an aliased import (User as U) to the source def", () => {
    const ctx = createResolutionContext();
    ctx.symbols.add("src/models.ts", "User", "sym-user", "class");
    ctx.symbols.add("src/other.ts", "U", "sym-noise", "class"); // a same-named decoy

    const files = ["src/consumer.ts", "src/models.ts", "src/other.ts"];
    const hints: ImportHintLike[] = [
      {
        kind: "import",
        sourceFile: "src/consumer.ts",
        targetName: "./models",
        language: "typescript",
        namedBindings: [{ local: "U", exported: "User" }],
      },
    ];
    populateImportMaps(ctx, hints, files, noConfigs);

    const result = ctx.resolve("U", "src/consumer.ts");
    expect(result?.tier).toBe("import-scoped");
    expect(result?.candidates[0].nodeId).toBe("sym-user");
  });

  it("resolves a 2-hop re-export chain A→B→C through walkBindingChain", () => {
    const ctx = createResolutionContext();
    // The real definition lives in C; B re-exports it; A imports from B.
    ctx.symbols.add("src/c.ts", "User", "sym-user", "class");

    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const hints: ImportHintLike[] = [
      {
        kind: "import",
        sourceFile: "src/a.ts",
        targetName: "./b",
        language: "typescript",
        namedBindings: [{ local: "User", exported: "User" }],
      },
      {
        kind: "import",
        sourceFile: "src/b.ts",
        targetName: "./c",
        language: "typescript",
        namedBindings: [{ local: "User", exported: "User" }],
      },
    ];
    populateImportMaps(ctx, hints, files, noConfigs);

    const result = ctx.resolve("User", "src/a.ts");
    expect(result?.tier).toBe("import-scoped");
    expect(result?.candidates[0].nodeId).toBe("sym-user");
  });
});

describe("Tier 2b (package-scoped) via populateImportMaps (Go)", () => {
  it("resolves a non-unique name to a def inside the imported package dir", () => {
    const ctx = createResolutionContext();
    // `Service` defined in two packages; only auth is imported.
    ctx.symbols.add("internal/billing/svc.go", "Service", "sym-billing", "class");
    ctx.symbols.add("internal/auth/svc.go", "Service", "sym-auth", "class");

    const files = ["cmd/main.go", "internal/auth/svc.go", "internal/billing/svc.go"];
    const configs: LanguageConfigs = { ...noConfigs, goModule: { modulePath: "github.com/org/repo" } };
    const hints: ImportHintLike[] = [
      { kind: "import", sourceFile: "cmd/main.go", targetName: "github.com/org/repo/internal/auth", language: "go" },
    ];
    populateImportMaps(ctx, hints, files, configs);

    const result = ctx.resolve("Service", "cmd/main.go");
    expect(result?.tier).toBe("import-scoped");
    // Tier 2a (importMap member files) wins first and pins the auth def.
    expect(result?.candidates.map((c) => c.nodeId)).toEqual(["sym-auth"]);
  });
});
