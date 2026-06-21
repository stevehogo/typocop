/**
 * Wave 3 (Tier B) Task 5/7 — Phase-2 `receiverType` population, flag-gated.
 *
 * With `TYPOCOP_TYPE_ENV` ON, a `u.save()` call hint (after `const u = new
 * User()`) carries `receiverType: 'User'`. With the flag OFF, the emitted hints
 * are BYTE-IDENTICAL to the pre-Wave-3 output (golden additivity — no
 * `receiverType` key anywhere). Also: `this`/`self`/chained receivers are never
 * given a `receiverType` (no double-handling — precision guardrail).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "./init.js";
import { extractSymbolsWithQueries, type RawRelationshipHint } from "./extract-symbols.js";

const FILE = "/repo/src/te.ts";

describe("extractSymbolsWithQueries — receiverType (Tier B flag)", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });
  afterEach(() => { delete process.env.TYPOCOP_TYPE_ENV; });

  function hints(src: string): RawRelationshipHint[] {
    return extractSymbolsWithQueries(parser.parse(src), FILE, "typescript", parser).hints;
  }

  const KEYSTONE = "class User { save(){} }\nfunction run(){ const u = new User(); u.save(); }";

  it("flag ON: u.save() carries receiverType:'User'", () => {
    process.env.TYPOCOP_TYPE_ENV = "1";
    const calls = hints(KEYSTONE).filter((h) => h.kind === "call" && h.targetName === "save");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].receiverType).toBe("User");
  });

  it("flag OFF: hints are byte-identical (no receiverType key)", () => {
    // OFF first.
    delete process.env.TYPOCOP_TYPE_ENV;
    const off = hints(KEYSTONE);
    expect(off.some((h) => "receiverType" in h)).toBe(false);
    // Snapshot the call hint shape OFF.
    const offCall = off.find((h) => h.kind === "call" && h.targetName === "save");
    expect(offCall && "receiverType" in offCall).toBe(false);
  });

  it("flag ON: this.method() gets NO receiverType (handled by resolveReceiverType)", () => {
    process.env.TYPOCOP_TYPE_ENV = "1";
    const src = "class Repo { find(){ this.load(); } load(){} }";
    const call = hints(src).find((h) => h.kind === "call" && h.targetName === "load");
    expect(call?.receiverText).toBe("this");
    expect(call?.receiverType).toBeUndefined();
  });

  it("flag ON: bare free call fn() carries no receiverText/receiverType", () => {
    process.env.TYPOCOP_TYPE_ENV = "1";
    const src = "function helper(){}\nfunction run(){ helper(); }";
    const call = hints(src).find((h) => h.kind === "call" && h.targetName === "helper");
    expect(call?.receiverText).toBeUndefined();
    expect(call?.receiverType).toBeUndefined();
  });
});
