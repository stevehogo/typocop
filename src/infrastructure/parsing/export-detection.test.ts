/**
 * Wave 2 (1.3) — per-language export detection, asserted end-to-end through the
 * real extractor so the wired `Symbol.isExported` field is exercised. Each
 * language gets an exported/non-exported pair; `isExported` is shown to be
 * ORTHOGONAL to `visibility`.
 */
import { describe, it, expect } from "vitest";
import { initParser } from "./init.js";
import { extractSymbolsWithQueries } from "./extract-symbols.js";
import type { Language, Symbol } from "../../core/domain.js";

async function extract(lang: Language, file: string, src: string): Promise<Symbol[]> {
  const parser = await initParser(lang);
  return extractSymbolsWithQueries(parser.parse(src), file, lang, parser).symbols;
}

function exportedOf(symbols: Symbol[], name: string): boolean | undefined {
  return symbols.find((s) => s.name === name)?.isExported;
}

describe("isExported — per-language (end-to-end)", () => {
  it("TypeScript: export vs bare", async () => {
    const syms = await extract("typescript", "/r/a.ts", `export function pub() {}\nfunction priv() {}\n`);
    expect(exportedOf(syms, "pub")).toBe(true);
    expect(exportedOf(syms, "priv")).toBe(false);
  });

  it("JavaScript: export vs bare", async () => {
    const syms = await extract("javascript", "/r/a.js", `export function pub() {}\nfunction priv() {}\n`);
    expect(exportedOf(syms, "pub")).toBe(true);
    expect(exportedOf(syms, "priv")).toBe(false);
  });

  it("Python: name vs _name convention", async () => {
    const syms = await extract("python", "/r/a.py", `def pub():\n    pass\ndef _priv():\n    pass\n`);
    expect(exportedOf(syms, "pub")).toBe(true);
    expect(exportedOf(syms, "_priv")).toBe(false);
  });

  it("Go: uppercase vs lowercase first letter", async () => {
    const syms = await extract("go", "/r/a.go", `package m\nfunc Pub() {}\nfunc priv() {}\n`);
    expect(exportedOf(syms, "Pub")).toBe(true);
    expect(exportedOf(syms, "priv")).toBe(false);
  });

  it("Rust: pub vs private", async () => {
    const syms = await extract("rust", "/r/a.rs", `pub fn pub_fn() {}\nfn priv_fn() {}\n`);
    expect(exportedOf(syms, "pub_fn")).toBe(true);
    expect(exportedOf(syms, "priv_fn")).toBe(false);
  });

  it("Java: public vs private method", async () => {
    const syms = await extract("java", "/r/A.java", `class C { public void pub() {} private void priv() {} }\n`);
    expect(exportedOf(syms, "pub")).toBe(true);
    expect(exportedOf(syms, "priv")).toBe(false);
  });

  it("C#: public vs private method", async () => {
    const syms = await extract("csharp", "/r/A.cs", `class C { public void Pub() {} private void Priv() {} }\n`);
    expect(exportedOf(syms, "Pub")).toBe(true);
    expect(exportedOf(syms, "Priv")).toBe(false);
  });

  it("C: extern (default) vs static linkage", async () => {
    const syms = await extract("c", "/r/a.c", `int pub_fn(void) { return 0; }\nstatic int priv_fn(void) { return 0; }\n`);
    expect(exportedOf(syms, "pub_fn")).toBe(true);
    expect(exportedOf(syms, "priv_fn")).toBe(false);
  });

  it("C++: extern (default) vs static linkage", async () => {
    const syms = await extract("cpp", "/r/a.cpp", `int pub_fn() { return 0; }\nstatic int priv_fn() { return 0; }\n`);
    expect(exportedOf(syms, "pub_fn")).toBe(true);
    expect(exportedOf(syms, "priv_fn")).toBe(false);
  });

  it("Swift: public vs default-internal", async () => {
    const syms = await extract("swift", "/r/a.swift", `public func pub() {}\nfunc internalFn() {}\n`);
    expect(exportedOf(syms, "pub")).toBe(true);
    expect(exportedOf(syms, "internalFn")).toBe(false);
  });

  it("Ruby: methods are reachable by default (always true)", async () => {
    const syms = await extract("ruby", "/r/a.rb", `def any_method\nend\n`);
    expect(exportedOf(syms, "any_method")).toBe(true);
  });

  it("PHP: top-level function is globally accessible", async () => {
    const syms = await extract("php", "/r/a.php", `<?php function topLevel() {}\n`);
    expect(exportedOf(syms, "topLevel")).toBe(true);
  });
});

describe("isExported is orthogonal to visibility", () => {
  it("a Python public-by-convention fn has isExported=true while visibility stays 'public'", async () => {
    // Python has no access modifiers, so `visibility` always falls through to
    // "public"; `isExported` reflects the `_`-prefix convention independently.
    const syms = await extract("python", "/r/a.py", `def _priv():\n    pass\n`);
    const priv = syms.find((s) => s.name === "_priv");
    expect(priv?.visibility).toBe("public"); // fall-through visibility
    expect(priv?.isExported).toBe(false);    // export detection disagrees — the point of 1.3
  });
});
