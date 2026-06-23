/**
 * Plan D #5 — getTaintSpec classifies known TS/JS source/sink/sanitizer patterns
 * and respects import provenance. Harness copied from complexity.test.ts.
 */
import { describe, it, expect } from "vitest";
import type Parser from "tree-sitter";
import { initParser } from "../init.js";
import {
  getTaintSpec,
  EMPTY_PROVENANCE,
  type ImportProvenance,
  type TaintNodeCtx,
} from "./source-sink-config.js";
import { buildImportProvenance } from "./specs/typescript.js";

/** Parse `src`, return the first node satisfying `pick` (BFS). */
async function nodeOf(src: string, pick: (n: Parser.SyntaxNode) => boolean): Promise<Parser.SyntaxNode> {
  const parser = await initParser("typescript");
  const tree = parser.parse(src);
  const queue: Parser.SyntaxNode[] = [tree.rootNode];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (pick(n)) return n;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) queue.push(c);
    }
  }
  throw new Error("node not found");
}
const callNamed = (name: string) => (n: Parser.SyntaxNode): boolean =>
  n.type === "call_expression" && (n.childForFieldName("function")?.text ?? "").includes(name);
const memberNamed = (text: string) => (n: Parser.SyntaxNode): boolean =>
  n.type === "member_expression" && n.text === text;

const cpProvenance: ImportProvenance = buildImportProvenance([
  { targetName: "child_process", namedBindings: [{ local: "exec", exported: "exec" }] },
]);
const cpNamespace: ImportProvenance = buildImportProvenance([
  { targetName: "child_process", localName: "cp" },
]);
const fsNamespace: ImportProvenance = buildImportProvenance([
  { targetName: "fs", localName: "fs" },
]);

const spec = () => {
  const s = getTaintSpec("typescript");
  if (!s) throw new Error("no TS spec");
  return s;
};
const ctx = (node: Parser.SyntaxNode, imports: ImportProvenance = EMPTY_PROVENANCE): TaintNodeCtx => ({ node, imports });

describe("getTaintSpec — registry", () => {
  it("returns a spec for typescript + javascript, null for python", () => {
    expect(getTaintSpec("typescript")).not.toBeNull();
    expect(getTaintSpec("javascript")).not.toBeNull();
    expect(getTaintSpec("python")).toBeNull();
  });
});

describe("sources", () => {
  it("flags req.query.id as a source", async () => {
    const n = await nodeOf(`const id = req.query.id;`, memberNamed("req.query.id"));
    expect(spec().isSource(ctx(n))).toBe(true);
  });
  it("flags req.body / req.params", async () => {
    const b = await nodeOf(`const x = req.body;`, memberNamed("req.body"));
    const p = await nodeOf(`const y = req.params;`, memberNamed("req.params"));
    expect(spec().isSource(ctx(b))).toBe(true);
    expect(spec().isSource(ctx(p))).toBe(true);
  });
  it("flags process.argv", async () => {
    const n = await nodeOf(`const a = process.argv;`, memberNamed("process.argv"));
    expect(spec().isSource(ctx(n))).toBe(true);
  });
  it("does NOT flag process.env (documented exclusion)", async () => {
    const n = await nodeOf(`const e = process.env;`, memberNamed("process.env"));
    expect(spec().isSource(ctx(n))).toBe(false);
  });
});

describe("sinks (by SinkKind)", () => {
  it("command: imported exec(cmd) is a command sink", async () => {
    const n = await nodeOf(`exec(cmd);`, callNamed("exec"));
    expect(spec().sinkKind(ctx(n, cpProvenance))).toBe("command");
  });
  it("command: cp.exec(cmd) via namespace is a command sink", async () => {
    const n = await nodeOf(`cp.exec(cmd);`, callNamed("exec"));
    expect(spec().sinkKind(ctx(n, cpNamespace))).toBe("command");
  });
  it("import provenance: a LOCAL exec() (no import) is NOT a command sink", async () => {
    const n = await nodeOf(`exec(cmd);`, callNamed("exec"));
    expect(spec().sinkKind(ctx(n, EMPTY_PROVENANCE))).toBeNull();
  });
  it("code: eval(s) and new Function(s)", async () => {
    const e = await nodeOf(`eval(s);`, callNamed("eval"));
    expect(spec().sinkKind(ctx(e))).toBe("code");
    const f = await nodeOf(`const g = new Function(s);`, (n) => n.type === "new_expression");
    expect(spec().sinkKind(ctx(f))).toBe("code");
  });
  it("path: fs.readFile(p) via fs namespace", async () => {
    const n = await nodeOf(`fs.readFile(p, cb);`, callNamed("readFile"));
    expect(spec().sinkKind(ctx(n, fsNamespace))).toBe("path");
  });
  it("xss: res.send(html) with a non-literal arg", async () => {
    const n = await nodeOf(`res.send(html);`, callNamed("send"));
    expect(spec().sinkKind(ctx(n))).toBe("xss");
  });
  it("sql: db.query with a template-literal interpolation is a sql sink", async () => {
    const n = await nodeOf("db.query(`SELECT * FROM u WHERE id = ${id}`);", callNamed("query"));
    expect(spec().sinkKind(ctx(n))).toBe("sql");
  });
  it("sql: db.query with string concatenation is a sql sink", async () => {
    const n = await nodeOf('db.query("SELECT * FROM u WHERE id = " + id);', callNamed("query"));
    expect(spec().sinkKind(ctx(n))).toBe("sql");
  });
  it("sql: parameterized db.query(text, params) is NOT a bare sink", async () => {
    const n = await nodeOf('db.query("SELECT * FROM u WHERE id = ?", [id]);', callNamed("query"));
    expect(spec().sinkKind(ctx(n))).toBeNull();
  });
});

describe("sanitizers", () => {
  it("escaper: encodeURIComponent(x)", async () => {
    const n = await nodeOf(`const s = encodeURIComponent(x);`, callNamed("encodeURIComponent"));
    expect(spec().isSanitizer(ctx(n))).toBe(true);
  });
  it("numeric coercer: Number(x) / parseInt(x)", async () => {
    const num = await nodeOf(`const n = Number(x);`, callNamed("Number"));
    const pi = await nodeOf(`const n = parseInt(x, 10);`, callNamed("parseInt"));
    expect(spec().isSanitizer(ctx(num))).toBe(true);
    expect(spec().isSanitizer(ctx(pi))).toBe(true);
  });
  it("parameterized query: db.query(text, params) is a sanitizer", async () => {
    const n = await nodeOf('db.query("SELECT * FROM u WHERE id = ?", [id]);', callNamed("query"));
    expect(spec().isSanitizer(ctx(n))).toBe(true);
  });
  it("a plain string-only db.query is neither sink nor sanitizer", async () => {
    const n = await nodeOf('db.query("SELECT 1");', callNamed("query"));
    expect(spec().sinkKind(ctx(n))).toBeNull();
    expect(spec().isSanitizer(ctx(n))).toBe(false);
  });
});
