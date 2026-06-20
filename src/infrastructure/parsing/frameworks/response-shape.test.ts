/**
 * E3 — `extractResponseKeys` unit tests + Express route `responseKeys`
 * attachment. v1 collects TOP-LEVEL keys of `res.json({...})`, `res.send({...})`
 * and `return {...}` only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Parser from "tree-sitter";
import { initParser } from "../init.js";
import { extractResponseKeys } from "./response-shape.js";

describe("extractResponseKeys (TypeScript/JavaScript)", () => {
  let parser: Parser;
  beforeAll(async () => { parser = await initParser("typescript"); });
  afterAll(() => { parser = undefined as unknown as Parser; });

  function keysOf(src: string): string[] {
    const tree = parser.parse(src);
    // The handler is the first arrow/function node in the file.
    let handler: Parser.SyntaxNode | null = null;
    const walk = (n: Parser.SyntaxNode): void => {
      if (!handler && (n.type === "arrow_function" || n.type === "function_expression" || n.type === "function_declaration")) {
        handler = n;
      }
      for (const c of n.namedChildren) walk(c);
    };
    walk(tree.rootNode);
    return extractResponseKeys(handler ?? tree.rootNode, "typescript");
  }

  it("collects top-level keys of res.json({...})", () => {
    const keys = keysOf(`app.get('/u', (req, res) => { res.json({ data: [], page: 1 }); });`);
    expect(keys).toEqual(["data", "page"]);
  });

  it("collects top-level keys of res.send({...})", () => {
    const keys = keysOf(`app.get('/u', (req, res) => { res.send({ ok: true, total: 5 }); });`);
    expect(keys).toEqual(["ok", "total"]);
  });

  it("collects top-level keys of a returned object literal", () => {
    const keys = keysOf(`function handler() { return { id: 1, name: 'x' }; }`);
    expect(keys).toEqual(["id", "name"]);
  });

  it("handles shorthand and string keys, de-duplicating", () => {
    const keys = keysOf(`function h() { const data = 1; return { data, 'page': 2, data: 3 }; }`);
    expect(keys).toEqual(["data", "page"]);
  });

  it("ignores nested object keys (top-level only in v1)", () => {
    const keys = keysOf(`function h() { return { data: { nested: 1 }, page: 2 }; }`);
    expect(keys).toEqual(["data", "page"]);
  });

  it("returns [] for a handler with no response object", () => {
    expect(keysOf(`function h() { doSomething(); }`)).toEqual([]);
  });
});

describe("Express route parser attaches responseKeys (E3)", () => {
  it("attaches the top-level response keys to the route symbol", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { parseExpressFile } = await import("./express.js");

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "typocop-e3-"));
    const file = path.join(dir, "routes.js");
    await fs.writeFile(
      file,
      `const app = express();\napp.get('/users', (req, res) => { res.json({ data: [], page: 1 }); });\n`,
      "utf-8",
    );
    try {
      const symbols = await parseExpressFile(file);
      const route = symbols.find((s) => s.name === "GET /users");
      expect(route).toBeDefined();
      expect(route?.responseKeys).toEqual(["data", "page"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
