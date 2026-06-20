/**
 * FastAPI framework-specific parser.
 * Requirements: 14.7, 14.10
 */
import type { Symbol, FrameworkSupport } from "../../../core/domain.js";
import { extractSymbols } from "../extract-symbols.js";
import { fromSyntaxNode } from "../ast-node.js";
import path from "path";
import fs from "fs/promises";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";

export const FASTAPI_SUPPORT: FrameworkSupport = {
  framework: "FastAPI",
  language: "python",
  apiEndpoints: true,
  controllers: false,
  dbModels: true,
  supportedORMs: ["SQLAlchemy"],
  tracingLevel: "partial",
};

/**
 * Parse FastAPI route decorators.
 * Requirement: 14.7
 */
export async function parseFastAPIRoutes(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.endsWith(".py")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const symbols: Symbol[] = [];
    
    // Extract @app.get, @app.post, @router.get, etc.
    const routePattern = /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g;
    let match;
    
    while ((match = routePattern.exec(content)) !== null) {
      const [, method, route] = match;
      const lineNumber = content.substring(0, match.index).split("\n").length;
      
      symbols.push({
        id: `fastapi:route:${method}:${route}`,
        logicalKey: `fastapi:route:${method}:${route}`,
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
 * Parse SQLAlchemy models.
 * Requirement: 14.7
 */
export async function parseSQLAlchemyModels(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.endsWith(".py")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for classes that inherit from Base or declarative_base
    return symbols.filter((s: Symbol) => 
      s.kind === "class" && 
      s.signature && 
      (s.signature.includes("(Base)") || s.signature.includes("declarative_base"))
    );
  } catch {
    return [];
  }
}

/**
 * Main entry point for FastAPI parsing.
 */
export async function parseFastAPIFile(filePath: string): Promise<Symbol[]> {
  if (!filePath.endsWith(".py")) return [];
  
  const parser = new Parser();
  parser.setLanguage(Python as unknown as Parser.Language);
  
  const results = await Promise.all([
    parseFastAPIRoutes(filePath, parser),
    parseSQLAlchemyModels(filePath, parser),
  ]);
  return results.flat();
}
