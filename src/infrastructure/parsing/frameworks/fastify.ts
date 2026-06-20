/**
 * Fastify framework-specific parser.
 * Requirements: 14.5, 14.10
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

export const FASTIFY_SUPPORT: FrameworkSupport = {
  framework: "Fastify",
  language: "javascript",
  apiEndpoints: true,
  controllers: false,
  dbModels: true,
  supportedORMs: ["Prisma", "TypeORM", "Mongoose"],
  tracingLevel: "partial",
};

/**
 * Parse Fastify route handlers (fastify.get, fastify.post, etc.).
 * Requirement: 14.5
 */
export async function parseFastifyRoutes(filePath: string, parser: Parser): Promise<Symbol[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const symbols: Symbol[] = [];
    
    // Extract fastify.get/post/put/delete/patch patterns
    const routePattern = /fastify\.(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let match;
    
    while ((match = routePattern.exec(content)) !== null) {
      const [, method, route] = match;
      const lineNumber = content.substring(0, match.index).split("\n").length;
      
      symbols.push({
        id: `fastify:route:${method}:${route}`,
        logicalKey: `fastify:route:${method}:${route}`,
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
 * Parse Fastify middleware/hooks.
 * Requirement: 14.5
 */
export async function parseFastifyHooks(filePath: string, parser: Parser): Promise<Symbol[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for hook functions (request, reply) signature
    return symbols.filter((s: Symbol) => 
      s.kind === "function" && 
      s.signature && 
      /\(.*request.*reply.*\)/.test(s.signature)
    );
  } catch {
    return [];
  }
}

/**
 * Main entry point for Fastify parsing.
 */
export async function parseFastifyFile(filePath: string): Promise<Symbol[]> {
  const ext = path.extname(filePath);
  if (ext !== ".js" && ext !== ".ts" && ext !== ".tsx") return [];
  
  const parser = new Parser();
  const lang = ext === ".tsx" ? TypeScript.tsx : ext === ".ts" ? TypeScript.typescript : JavaScript;
  parser.setLanguage(lang as unknown as Parser.Language);
  
  const results = await Promise.all([
    parseFastifyRoutes(filePath, parser),
    parseFastifyHooks(filePath, parser),
  ]);
  return results.flat();
}
