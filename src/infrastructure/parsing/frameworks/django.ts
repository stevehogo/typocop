/**
 * Django framework-specific parser.
 * Requirements: 14.8, 14.10
 */
import type { Symbol, FrameworkSupport } from "../../../core/domain.js";
import { extractSymbols } from "../extract-symbols.js";
import { fromSyntaxNode } from "../ast-node.js";
import path from "path";
import fs from "fs/promises";
import Parser from "tree-sitter";
import Python from "tree-sitter-python";

export const DJANGO_SUPPORT: FrameworkSupport = {
  framework: "Django",
  language: "python",
  apiEndpoints: true,
  controllers: false,
  dbModels: true,
  supportedORMs: ["Django ORM"],
  tracingLevel: "partial",
};

/**
 * Parse Django URL patterns.
 * Requirement: 14.8
 */
export async function parseDjangoURLPatterns(filePath: string): Promise<Symbol[]> {
  const basename = path.basename(filePath);
  if (basename !== "urls.py") return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const symbols: Symbol[] = [];
    
    // Extract path() patterns: path('api/users/', views.user_list)
    const pathPattern = /path\s*\(\s*['"]([^'"]+)['"]/g;
    let match;
    
    while ((match = pathPattern.exec(content)) !== null) {
      const [, route] = match;
      const lineNumber = content.substring(0, match.index).split("\n").length;
      
      symbols.push({
        id: `django:url:${route}`,
        logicalKey: `django:url:${route}`,
        name: `URL ${route}`,
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
    
    // Also extract re_path() patterns
    const rePathPattern = /re_path\s*\(\s*r?['"]([^'"]+)['"]/g;
    while ((match = rePathPattern.exec(content)) !== null) {
      const [, route] = match;
      const lineNumber = content.substring(0, match.index).split("\n").length;
      
      symbols.push({
        id: `django:url:regex:${route}`,
        logicalKey: `django:url:regex:${route}`,
        name: `URL ${route}`,
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
 * Parse Django ORM models.
 * Requirement: 14.8
 */
export async function parseDjangoModels(filePath: string, parser: Parser): Promise<Symbol[]> {
  const basename = path.basename(filePath);
  if (basename !== "models.py") return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for classes that inherit from models.Model
    return symbols.filter((s: Symbol) => 
      s.kind === "class" && 
      s.signature && 
      s.signature.includes("models.Model")
    );
  } catch {
    return [];
  }
}

/**
 * Main entry point for Django parsing.
 */
export async function parseDjangoFile(filePath: string): Promise<Symbol[]> {
  if (!filePath.endsWith(".py")) return [];
  
  const basename = path.basename(filePath);
  
  // Handle URL patterns
  if (basename === "urls.py") {
    return parseDjangoURLPatterns(filePath);
  }
  
  // Handle models
  if (basename === "models.py") {
    const parser = new Parser();
    parser.setLanguage(Python as unknown as Parser.Language);
    return parseDjangoModels(filePath, parser);
  }
  
  return [];
}
