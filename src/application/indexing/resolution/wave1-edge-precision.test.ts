/**
 * Wave 1 — before/after edge-precision harness (plan §7.6).
 *
 * Runs `resolveHints` on multi-language fixtures (TS/JS/Python/Go/PHP/Java) WITH
 * and WITHOUT the threaded `allFiles`, asserting:
 *   (a) the `calls`/`imports` edge COUNT is stable (±0 — this is a precision,
 *       not a recall, change), and
 *   (b) for a planted NON-UNIQUE name, the resolved target CHANGES from the
 *       global first-match (wrong) to the imported definition (right).
 *
 * Each fixture defines a symbol name in TWO files (the "wrong" one inserted
 * first so it wins Tier 3), imports exactly ONE of them, and calls/imports the
 * name from a consumer.
 */
import { describe, it, expect } from "vitest";
import type { Language, Symbol, Relationship } from "../../../core/domain.js";
import type { LanguageConfigs } from "../language-config.js";
import type { RawRelationshipHint } from "../parsing/index.js";
import { resolveHints } from "./index.js";

const noConfigs: LanguageConfigs = {
  tsconfig: null,
  composer: null,
  goModule: null,
  csharp: [],
  swift: null,
};

function sym(id: string, name: string, filePath: string, kind: Symbol["kind"], startLine = 1, endLine = 50): Symbol {
  return {
    id,
    logicalKey: id,
    name,
    kind,
    visibility: "public",
    modifiers: [],
    location: { filePath, startLine, startColumn: 0, endLine, endColumn: 0 },
  };
}

function callsTo(rels: Relationship[]): Relationship[] {
  return rels.filter((r) => r.relType === "calls");
}
function importsTo(rels: Relationship[]): Relationship[] {
  return rels.filter((r) => r.relType === "imports" && !(r.target as string).startsWith("unresolved:"));
}

interface Fixture {
  readonly language: Language;
  readonly configs: LanguageConfigs;
  readonly files: string[];
  readonly symbols: Symbol[];
  readonly hints: RawRelationshipHint[];
  /** The call/import-target name planted as non-unique. */
  readonly plantedName: string;
  /** Symbol id that SHOULD win (imported def). */
  readonly rightId: string;
  /** Symbol id that wins WITHOUT the import maps (global first-match). */
  readonly wrongId: string;
}

/** A consumer file that imports the RIGHT file and CALLS the planted name. */
function buildFixture(
  language: Language,
  configs: LanguageConfigs,
  opts: {
    consumer: string;
    rightFile: string;
    wrongFile: string;
    importSpecifier: string;
    plantedName: string;
  },
): Fixture {
  const { consumer, rightFile, wrongFile, importSpecifier, plantedName } = opts;
  // wrong inserted FIRST → Tier 3 global first-match.
  const symbols: Symbol[] = [
    sym(`wrong:${plantedName}`, plantedName, wrongFile, "function"),
    sym(`right:${plantedName}`, plantedName, rightFile, "function"),
    sym(`caller`, "caller", consumer, "function", 1, 20),
  ];
  const hints: RawRelationshipHint[] = [
    { kind: "import", sourceFile: consumer, targetName: importSpecifier, startLine: 0, language },
    { kind: "call", sourceFile: consumer, targetName: plantedName, startLine: 5, language },
  ];
  return {
    language,
    configs,
    files: [consumer, rightFile, wrongFile],
    symbols,
    hints,
    plantedName,
    rightId: `right:${plantedName}`,
    wrongId: `wrong:${plantedName}`,
  };
}

const fixtures: Record<string, Fixture> = {
  typescript: buildFixture("typescript", noConfigs, {
    consumer: "src/consumer.ts",
    rightFile: "src/right.ts",
    wrongFile: "src/wrong.ts",
    importSpecifier: "./right",
    plantedName: "process",
  }),
  javascript: buildFixture("javascript", noConfigs, {
    consumer: "src/consumer.js",
    rightFile: "src/right.js",
    wrongFile: "src/wrong.js",
    importSpecifier: "./right",
    plantedName: "handle",
  }),
  python: buildFixture("python", noConfigs, {
    consumer: "pkg/consumer.py",
    rightFile: "pkg/right.py",
    wrongFile: "pkg/wrong.py",
    importSpecifier: ".right",
    plantedName: "run",
  }),
  go: buildFixture("go", { ...noConfigs, goModule: { modulePath: "github.com/org/repo" } }, {
    consumer: "cmd/main.go",
    rightFile: "internal/auth/svc.go",
    wrongFile: "internal/billing/svc.go",
    importSpecifier: "github.com/org/repo/internal/auth",
    plantedName: "Serve",
  }),
  php: buildFixture("php", { ...noConfigs, composer: { psr4: new Map([["App\\", "app"]]) } }, {
    consumer: "app/Consumer.php",
    rightFile: "app/Right/Helper.php",
    wrongFile: "app/Wrong/Helper.php",
    importSpecifier: "App\\Right\\Helper",
    plantedName: "perform",
  }),
  java: buildFixture("java", noConfigs, {
    consumer: "src/com/example/Consumer.java",
    rightFile: "src/com/example/right/Helper.java",
    wrongFile: "src/com/example/wrong/Helper.java",
    importSpecifier: "com.example.right.Helper",
    plantedName: "execute",
  }),
};

describe.each(Object.entries(fixtures))("Wave 1 edge precision — %s", (lang, fx) => {
  it("edge COUNT is stable with vs without allFiles", () => {
    const before = resolveHints(fx.hints, fx.symbols, fx.configs); // no allFiles → pre-wave
    const after = resolveHints(fx.hints, fx.symbols, fx.configs, fx.files); // wave on

    expect(callsTo(after.relationships).length).toBe(callsTo(before.relationships).length);
    expect(importsTo(after.relationships).length).toBe(importsTo(before.relationships).length);
    expect(after.relationships.length).toBe(before.relationships.length);
  });

  it("planted non-unique CALL target changes wrong→right", () => {
    const before = resolveHints(fx.hints, fx.symbols, fx.configs);
    const after = resolveHints(fx.hints, fx.symbols, fx.configs, fx.files);

    const beforeCall = callsTo(before.relationships).find((r) => r.source === "caller");
    const afterCall = callsTo(after.relationships).find((r) => r.source === "caller");

    // Pre-wave: global first-match (wrong file inserted first).
    expect(beforeCall?.target).toBe(fx.wrongId);
    // Wave on: the imported definition.
    expect(afterCall?.target).toBe(fx.rightId);
  });
});

describe("Wave 1 edge precision — allFiles omitted is byte-identical to pre-wave", () => {
  it("produces the same relationship set whether allFiles is omitted or empty-effecting", () => {
    const fx = fixtures.typescript;
    const omitted = resolveHints(fx.hints, fx.symbols, fx.configs);
    const omittedAgain = resolveHints(fx.hints, fx.symbols, fx.configs, undefined);
    expect(JSON.stringify(omittedAgain.relationships)).toBe(JSON.stringify(omitted.relationships));
  });
});
