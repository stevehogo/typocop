/**
 * Verifies the call-hint `selfCallNoProgress` flag: true when a self-receiver
 * call re-passes the enclosing callable's parameters unchanged (the self-shadowing
 * / infinite-recursion hallmark), false when the call makes argument progress.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "./init.js";
import { extractSymbolsWithQueries } from "./extract-symbols.js";
import type { Language } from "../../core/domain.js";

function flag(parser: Parser, src: string, lang: Language, callee: string): boolean | undefined {
  const { hints } = extractSymbolsWithQueries(parser.parse(src), `/repo/x.${lang}`, lang, parser);
  return hints.find((h) => h.kind === "call" && h.targetName === callee)?.selfCallNoProgress;
}

describe("call hint selfCallNoProgress", () => {
  let php: Parser, ts: Parser, py: Parser;
  beforeAll(async () => {
    php = await initParser("php");
    ts = await initParser("typescript");
    py = await initParser("python");
  });
  afterAll(() => { php = ts = py = undefined as unknown as Parser; });

  it("PHP: 0-param method calling $this->itself() with 0 args → no progress", () => {
    const src = `<?php
class Ipn {
  public function _registerPaymentFailure() {
    try { $this->_registerPaymentFailure(); } catch (\\Exception $e) { throw $e; }
  }
}
`;
    expect(flag(php, src, "php", "_registerPaymentFailure")).toBe(true);
  });

  it("TS: this.f(x) in f(x) → no progress", () => {
    expect(flag(ts, `class C { f(x: number){ this.f(x); } }\n`, "typescript", "f")).toBe(true);
  });

  it("TS: this.walk(node.next) in walk(node) → progress (not flagged)", () => {
    const src = `class C { walk(node: any){ if (!node) return; this.walk(node.next); } }\n`;
    expect(flag(ts, src, "typescript", "walk")).toBeFalsy();
  });

  it("Python: self.walk(n) in walk(self, n) → no progress; self.walk(n.next) → progress", () => {
    expect(flag(py, `class C:\n  def walk(self, n):\n    return self.walk(n)\n`, "python", "walk")).toBe(true);
    expect(flag(py, `class C:\n  def walk(self, n):\n    if not n: return\n    return self.walk(n.next)\n`, "python", "walk")).toBeFalsy();
  });

  it("does not flag a non-self member call (different receiver)", () => {
    const src = `<?php
class Ipn {
  public function run() { $this->logger->debug('x'); }
}
`;
    // $this->logger->debug — receiver is $this->logger, not $this → no flag
    expect(flag(php, src, "php", "debug")).toBeFalsy();
  });
});
