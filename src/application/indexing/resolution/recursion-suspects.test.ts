import { describe, it, expect } from "vitest";
import { detectRecursionSuspects } from "./recursion-suspects.js";
import type { Symbol, Relationship, Language } from "../../../core/domain.js";
import type { RawRelationshipHint } from "../../../infrastructure/parsing/extract-symbols.js";

function method(id: string, name: string, file: string, start: number, end: number, paramCount?: number): Symbol {
  return {
    id, logicalKey: id, name, kind: "method",
    location: { filePath: file, startLine: start, startColumn: 0, endLine: end, endColumn: 0 },
    visibility: "public", modifiers: [], ...(paramCount !== undefined ? { parameterCount: paramCount } : {}),
  };
}
function callHint(
  file: string, line: number, callee: string,
  opts: { receiver?: string; argCount?: number; callText?: string; language?: Language } = {},
): RawRelationshipHint {
  return {
    kind: "call", sourceFile: file, targetName: callee, startLine: line, language: opts.language ?? "typescript",
    ...(opts.receiver ? { receiverText: opts.receiver } : {}),
    ...(opts.argCount !== undefined ? { argCount: opts.argCount } : {}),
    ...(opts.callText ? { callText: opts.callText } : {}),
  };
}
const overrides = (source: string, target: string): Relationship =>
  ({ id: `overrides:${source}->${target}`, source, target, relType: "overrides", metadata: {} });

describe("detectRecursionSuspects", () => {
  const base = method("base.save", "save", "Base.ts", 1, 3, 0);
  const derived = method("derived.save", "save", "Derived.ts", 10, 20, 0);

  it("signal A: flags an override calling this.<ownName>()", () => {
    const out = detectRecursionSuspects([base, derived], [callHint("Derived.ts", 15, "save", { receiver: "this" })], [overrides("derived.save", "base.save")]);
    expect(out).toEqual([{ callerId: "derived.save", callLine: 15, receiver: "this", language: "typescript", kind: "shadows-super" }]);
  });

  it("signal B: flags a 0-param method called with 1 arg (arity mismatch)", () => {
    const get = method("m.getTransId", "getTransId", "M.php", 28, 31, 0);
    const out = detectRecursionSuspects([get], [callHint("M.php", 29, "getTransId", { receiver: "this", argCount: 1, language: "php" })], []);
    expect(out).toEqual([{ callerId: "m.getTransId", callLine: 29, receiver: "this", language: "php", kind: "arity-mismatch" }]);
  });

  it("carries callText through when present", () => {
    const get = method("m.getTransId", "getTransId", "M.php", 28, 31, 0);
    const out = detectRecursionSuspects([get], [callHint("M.php", 29, "getTransId", { receiver: "this", argCount: 1, callText: "$this->getTransId(self::TRANS_ID)" })], []);
    expect(out[0]?.callText).toBe("$this->getTransId(self::TRANS_ID)");
  });

  it("does NOT flag super.<ownName>() (qualified)", () => {
    expect(detectRecursionSuspects([base, derived], [callHint("Derived.ts", 15, "save", { receiver: "super" })], [overrides("derived.save", "base.save")])).toEqual([]);
  });

  it("does NOT flag matching-arity recursion with no overrides edge (legit)", () => {
    const walk = method("u.walk", "walk", "U.ts", 1, 9, 0);
    expect(detectRecursionSuspects([walk], [callHint("U.ts", 5, "walk", { receiver: "this", argCount: 0 })], [])).toEqual([]);
  });

  it("does NOT flag a variadic method (parameterCount undefined) even with extra args", () => {
    const log = method("u.log", "log", "U.ts", 1, 9); // no parameterCount → variadic
    expect(detectRecursionSuspects([log], [callHint("U.ts", 5, "log", { receiver: "this", argCount: 3 })], [])).toEqual([]);
  });

  it("does NOT flag a different method name", () => {
    expect(detectRecursionSuspects([base, derived], [callHint("Derived.ts", 15, "other", { receiver: "this" })], [overrides("derived.save", "base.save")])).toEqual([]);
  });

  it("prefers signal A over B for the same caller", () => {
    const d = method("d.save", "save", "D.ts", 10, 20, 0);
    const out = detectRecursionSuspects([base, d], [callHint("D.ts", 15, "save", { receiver: "this", argCount: 2 })], [overrides("d.save", "base.save")]);
    expect(out[0]?.kind).toBe("shadows-super");
  });

  it("orders findings by (filePath, callLine)", () => {
    const a = method("a", "run", "A.ts", 1, 9, 0);
    const b = method("b", "run", "B.ts", 1, 9, 0);
    const out = detectRecursionSuspects(
      [a, b], [callHint("B.ts", 5, "run", { receiver: "this", argCount: 1 }), callHint("A.ts", 5, "run", { receiver: "this", argCount: 1 })], [],
    );
    expect(out.map((s) => s.callerId)).toEqual(["a", "b"]);
  });

  it("normalizes a PHP $this receiver to this (signal B)", () => {
    const get = method("m.getTransId", "getTransId", "M.php", 28, 31, 0);
    const out = detectRecursionSuspects([get], [callHint("M.php", 29, "getTransId", { receiver: "$this", argCount: 1, language: "php" })], []);
    expect(out).toEqual([{ callerId: "m.getTransId", callLine: 29, receiver: "this", language: "php", kind: "arity-mismatch" }]);
  });
});
