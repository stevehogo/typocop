/**
 * Regression: a FULLY-QUALIFIED `extends \Ns\Class` must resolve to the in-tree
 * parent symbol so `inherits` (and thus `overrides`) edges form. Previously the
 * heritage lookup used the raw qualified name against a simple-name-keyed symbol
 * map, so FQN extends silently produced no edge.
 */
import { describe, it, expect } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "../../../infrastructure/parsing/init.js";
import { extractSymbolsWithQueries } from "../../../infrastructure/parsing/extract-symbols.js";
import { resolveReferences } from "./index.js";
import type { Symbol } from "../../../core/domain.js";
import type { RawRelationshipHint } from "../../../infrastructure/parsing/extract-symbols.js";

const CHILD = `<?php
namespace App;
class Ipn extends \\Vendor\\AbstractIpn {
  public function save() { $this->save(); }
}
`;
const PARENT = `<?php
namespace Vendor;
class AbstractIpn { public function save() { /* real */ } }
`;

async function parseAndResolve(files: Array<{ path: string; src: string }>) {
  const parser = await initParser("php");
  const symbols: Symbol[] = [];
  const hints: RawRelationshipHint[] = [];
  for (const f of files) {
    const r = extractSymbolsWithQueries(parser.parse(f.src), f.path, "php", parser);
    symbols.push(...r.symbols);
    hints.push(...r.hints);
  }
  const { relationships } = await resolveReferences(symbols, hints, undefined, files.map((f) => f.path));
  return relationships;
}

describe("fully-qualified heritage resolution", () => {
  it("forms inherits + overrides edges for `extends \\Ns\\Class`", async () => {
    const rels = await parseAndResolve([
      { path: "/r/Ipn.php", src: CHILD },
      { path: "/r/AbstractIpn.php", src: PARENT },
    ]);
    expect(rels.some((r) => r.relType === "inherits")).toBe(true);
    expect(rels.some((r) => r.relType === "overrides")).toBe(true);
  });
});
