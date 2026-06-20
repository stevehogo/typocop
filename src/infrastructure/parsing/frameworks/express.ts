/**
 * Express framework-specific parser.
 * Requirements: 14.4, 14.10
 */
import type { Symbol, FrameworkSupport, Language } from "../../../core/domain.js";
import { extractSymbols } from "../extract-symbols.js";
import { fromSyntaxNode } from "../ast-node.js";
import { extractResponseKeys } from "./response-shape.js";
import path from "path";
import fs from "fs/promises";
import Parser from "tree-sitter";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const TypeScript = require("tree-sitter-typescript") as {
  typescript: Parser.Language;
  tsx: Parser.Language;
};
import JavaScript from "tree-sitter-javascript";

export const EXPRESS_SUPPORT: FrameworkSupport = {
  framework: "Express",
  language: "javascript",
  apiEndpoints: true,
  controllers: false,
  dbModels: true,
  supportedORMs: ["Prisma", "TypeORM", "Mongoose"],
  tracingLevel: "partial",
};

/**
 * Parse Express route handlers (app.get, app.post, etc.).
 * Requirement: 14.4
 */
const HTTP_METHODS: ReadonlySet<string> = new Set(["get", "post", "put", "delete", "patch", "all"]);

export async function parseExpressRoutes(filePath: string, parser: Parser): Promise<Symbol[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const language: Language = filePath.endsWith(".ts") || filePath.endsWith(".tsx")
      ? "typescript"
      : "javascript";
    const symbols: Symbol[] = [];

    // Walk for `app.<method>('<route>', ..., handler)` call expressions so we can
    // reach the handler node and extract its response shape (E3).
    walkCalls(tree.rootNode, (call) => {
      const callee = call.childForFieldName("function");
      if (callee?.type !== "member_expression") return;
      const method = callee.childForFieldName("property")?.text;
      if (!method || !HTTP_METHODS.has(method)) return;

      const args = call.childForFieldName("arguments");
      const argNodes = args?.namedChildren ?? [];
      const routeArg = argNodes[0];
      if (!routeArg || routeArg.type !== "string") return;
      const route = routeArg.text.replace(/^['"`]|['"`]$/g, "");
      if (!route) return;

      // The handler is the last argument that is a function/arrow.
      const handler = [...argNodes].reverse().find(
        (a) => a.type === "arrow_function" || a.type === "function_expression",
      );
      const responseKeys = handler ? extractResponseKeys(handler, language) : [];

      const id = `express:route:${method}:${route}`;
      symbols.push({
        id,
        // Framework route ids are already position-independent (route-derived),
        // so the persisted logicalKey is the same stable id (A1).
        logicalKey: id,
        name: `${method.toUpperCase()} ${route}`,
        kind: "function",
        location: {
          filePath,
          startLine: call.startPosition.row + 1,
          startColumn: 0,
          endLine: call.endPosition.row + 1,
          endColumn: 0,
        },
        visibility: "public",
        modifiers: [],
        ...(responseKeys.length > 0 ? { responseKeys } : {}),
      });
    });

    return symbols;
  } catch {
    return [];
  }
}

/** Pre-order DFS collecting `call_expression` nodes. */
function walkCalls(node: Parser.SyntaxNode, visit: (n: Parser.SyntaxNode) => void): void {
  if (node.type === "call_expression") visit(node);
  for (const child of node.namedChildren) walkCalls(child, visit);
}

/**
 * Parse Express middleware chains.
 * Requirement: 14.4
 */
export async function parseExpressMiddleware(filePath: string, parser: Parser): Promise<Symbol[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for middleware functions (req, res, next) signature
    return symbols.filter((s: Symbol) => 
      s.kind === "function" && 
      s.signature && 
      /\(.*req.*res.*next.*\)/.test(s.signature)
    );
  } catch {
    return [];
  }
}

/**
 * Main entry point for Express parsing.
 */
export async function parseExpressFile(filePath: string): Promise<Symbol[]> {
  const ext = path.extname(filePath);
  if (ext !== ".js" && ext !== ".ts" && ext !== ".tsx") return [];
  
  const parser = new Parser();
  const lang = ext === ".tsx" ? TypeScript.tsx : ext === ".ts" ? TypeScript.typescript : JavaScript;
  parser.setLanguage(lang as unknown as Parser.Language);
  
  const results = await Promise.all([
    parseExpressRoutes(filePath, parser),
    parseExpressMiddleware(filePath, parser),
  ]);
  return results.flat();
}
