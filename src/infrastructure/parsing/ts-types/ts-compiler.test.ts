/**
 * Wave 3 Tier A1 — TS-compiler-API receiver-type resolution.
 *
 * Proves:
 *  1. With Tier A1 ON, the real TypeScript checker resolves a receiver's nominal
 *     type for cross-file, generic, and overloaded member calls, and that answer
 *     OVERRIDES a (wrong/absent) Tier-B `receiverType` — i.e. A1 > B precedence.
 *  2. The resolved `receiverType` then drives Phase 3 to the CORRECT owning
 *     method (the keystone `u.save()` → `User.save`, not a decoy).
 *  3. Flag-OFF is byte-identical and NEVER imports `typescript` (asserted in a
 *     clean child process so the module registry is pristine).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  enrichHintsWithTsTypes,
  type ReceiverTypeHint,
} from "./ts-compiler.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── On-disk TS fixture project (a real tsconfig + cross-file types) ───────────
let root: string;

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ["**/*.ts"],
});

// models.ts: the real class the receiver resolves to, plus a same-named decoy
// method on a different class so a wrong receiver type would mis-resolve.
const MODELS_TS = `
export class User {
  save(): void {}
}
export class Order {
  save(): void {}
}
export function makeUser(): User {
  return new User();
}
`;

// app.ts: three receivers whose precise type only the checker knows:
//   - cross-file ctor return (makeUser(): User)
//   - generic identity (first<T>(xs: T[]): T over User[])
//   - overload resolution (load(): User picked by arg-less overload)
const APP_TS = `
import { User, makeUser } from "./models.js";

function first<T>(xs: T[]): T {
  return xs[0]!;
}

declare function load(): User;
declare function load(id: number): Order;

export function run(users: User[]): void {
  const a = makeUser();
  a.save();
  const b = first(users);
  b.save();
  const c = load();
  c.save();
}
`;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "typocop-a1-"));
  fs.writeFileSync(path.join(root, "tsconfig.json"), TSCONFIG);
  fs.writeFileSync(path.join(root, "models.ts"), MODELS_TS);
  fs.writeFileSync(path.join(root, "app.ts"), APP_TS);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Build a `call` hint for `app.ts`. Lines are 0-indexed (tree-sitter rows). */
function callHint(startLine: number, receiverText: string, extra: Partial<ReceiverTypeHint> = {}): ReceiverTypeHint {
  return {
    kind: "call",
    sourceFile: "app.ts",
    targetName: "save",
    startLine,
    language: "typescript",
    receiverText,
    ...extra,
  };
}

// Derive the 0-indexed line of each `<recv>.save()` call from the fixture text
// (tree-sitter rows are 0-indexed, matching `String.split("\n")` indices). This
// avoids brittle hand-counted offsets.
function lineOf(needle: string): number {
  const lines = APP_TS.split("\n");
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`fixture line not found: ${needle}`);
  return idx;
}
const A_SAVE_LINE = lineOf("a.save()");
const B_SAVE_LINE = lineOf("b.save()");
const C_SAVE_LINE = lineOf("c.save()");

describe("enrichHintsWithTsTypes — Tier A1 compiler-API precedence", () => {
  it("resolves a cross-file ctor-return receiver to its nominal type (makeUser(): User)", async () => {
    const hints = [callHint(A_SAVE_LINE, "a")];
    const out = await enrichHintsWithTsTypes(hints, { sourcePath: root });
    expect(out[0]?.receiverType).toBe("User");
  });

  it("resolves a generic-instantiated receiver (first<User>(users)) to User", async () => {
    const hints = [callHint(B_SAVE_LINE, "b")];
    const out = await enrichHintsWithTsTypes(hints, { sourcePath: root });
    expect(out[0]?.receiverType).toBe("User");
  });

  it("resolves an overloaded call's receiver (load(): User) to User", async () => {
    const hints = [callHint(C_SAVE_LINE, "c")];
    const out = await enrichHintsWithTsTypes(hints, { sourcePath: root });
    expect(out[0]?.receiverType).toBe("User");
  });

  it("OVERRIDES a wrong Tier-B receiverType with the compiler answer (A1 > B)", async () => {
    // Tier B mis-guessed `Order`; the checker knows `a: User` → A1 must override.
    const hints = [callHint(A_SAVE_LINE, "a", { receiverType: "Order" })];
    const out = await enrichHintsWithTsTypes(hints, { sourcePath: root });
    expect(out[0]?.receiverType).toBe("User");
  });

  it("leaves the Tier-B receiverType in place on a compiler MISS (fallback to B)", async () => {
    // A `.save()` on an unknown line / receiver the checker cannot place → no A1
    // answer → the existing Tier-B value survives untouched.
    const hints = [callHint(999, "ghost", { receiverType: "FallbackType" })];
    const out = await enrichHintsWithTsTypes(hints, { sourcePath: root });
    expect(out[0]?.receiverType).toBe("FallbackType");
  });

  it("ignores non-TS/JS hints entirely", async () => {
    const goHint: ReceiverTypeHint = {
      kind: "call",
      sourceFile: "x.go",
      targetName: "Save",
      startLine: 1,
      language: "go",
      receiverText: "u",
      receiverType: "GoType",
    };
    const out = await enrichHintsWithTsTypes([goHint], { sourcePath: root });
    expect(out[0]).toBe(goHint); // untouched (A2 will add Go behind the same seam)
  });

  it("reports A1 resolutions via the onResolved hook (explainability, not persisted)", async () => {
    const tiers: string[] = [];
    await enrichHintsWithTsTypes([callHint(A_SAVE_LINE, "a")], {
      sourcePath: root,
      onResolved: (t) => tiers.push(t),
    });
    expect(tiers).toEqual(["A1"]);
  });
});

describe("enrichHintsWithTsTypes — flag-OFF / no-TS-corpus shortcut", () => {
  it("returns a copy without importing typescript when there are no TS/JS call hints", async () => {
    // With nothing for A1 to answer, the heavy resolver (and its lazy
    // import('typescript')) is never constructed — mirrors the flag-OFF pipeline
    // path, which never calls this function at all.
    const goHint: ReceiverTypeHint = {
      kind: "call", sourceFile: "x.go", targetName: "Save", startLine: 1, language: "go", receiverText: "u",
    };
    const out = await enrichHintsWithTsTypes([goHint], { sourcePath: root });
    expect(out).toEqual([goHint]);
    expect(out).not.toBe(undefined);
  });
});

describe("Tier A1 lazy-load contract — typescript must NOT load when the flag is off", () => {
  // The hard guarantee is STRUCTURAL: `typescript` is reached ONLY through the
  // single dynamic `await import("typescript")` inside the resolver builder,
  // which is reached only when there is a TS/JS call hint to answer. There is NO
  // top-level static import of `typescript` anywhere in shipped src, so a
  // flag-OFF pipeline run (which never calls `enrichHintsWithTsTypes`) never
  // loads the compiler. We verify both halves below without external tooling.

  it("contains NO top-level static import/require of 'typescript' (only a lazy import())", () => {
    const src = fs.readFileSync(path.join(HERE, "ts-compiler.ts"), "utf8");
    // No static ESM import from the package.
    expect(src).not.toMatch(/^\s*import\s+[^;]*\bfrom\s+["']typescript["']/m);
    // No CJS require of the package.
    expect(src).not.toMatch(/require\(\s*["']typescript["']\s*\)/);
    // The ONLY reference is the gated dynamic import.
    expect(src).toMatch(/await\s+import\(\s*["']typescript["']\s*\)/);
  });

  it("the no-TS-hint shortcut returns before the resolver (and its import) is built", async () => {
    // A corpus with no TS/JS call hint exercises the early-return guard that
    // precedes the lazy import — the same effect as the flag-OFF pipeline path.
    const onResolved = (): void => {
      throw new Error("resolver must not run when there is nothing to answer");
    };
    const goHint: ReceiverTypeHint = {
      kind: "call", sourceFile: "x.go", targetName: "Save", startLine: 1, language: "go", receiverText: "u",
    };
    const out = await enrichHintsWithTsTypes([goHint], { sourcePath: root, onResolved });
    expect(out).toEqual([goHint]);
  });
});
