/**
 * Express framework-specific parser.
 * Requirements: 14.4, 14.10
 */
import type { Symbol, FrameworkSupport } from "../../../core/domain.js";
import { extractSymbols } from "../extract-symbols.js";
import { fromSyntaxNode } from "../ast-node.js";
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
export async function parseExpressRoutes(filePath: string, parser: Parser): Promise<Symbol[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const symbols: Symbol[] = [];
    
    // Extract app.get/post/put/delete/patch patterns
    const routePattern = /app\.(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    
    while ((match = routePattern.exec(content)) !== null) {
      const [, method, route] = match;
      const lineNumber = content.substring(0, match.index).split("\n").length;
      
      symbols.push({
        id: `express:route:${method}:${route}`,
        name: `${method.toUpperCase()} ${route}`,
        kind: "function",
        location: {
          filePath,
          startLine: lineNumber,
          startColumn: 0,
          endLine: lineNumber,
          endColumn: 0,
        },
        visibility: "public",
        modifiers: [],
      });
    }
    
    return symbols;
  } catch {
    return [];
  }
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
