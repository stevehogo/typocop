/**
 * Spring Boot framework-specific parser.
 * Requirements: 14.6, 14.10
 */
import type { Symbol, FrameworkSupport } from "../../../core/domain.js";
import { extractSymbols } from "../extract-symbols.js";
import { fromSyntaxNode } from "../ast-node.js";
import path from "path";
import fs from "fs/promises";
import Parser from "tree-sitter";
import Java from "tree-sitter-java";

export const SPRING_BOOT_SUPPORT: FrameworkSupport = {
  framework: "Spring Boot",
  language: "java",
  apiEndpoints: true,
  controllers: false,
  dbModels: true,
  supportedORMs: ["JPA", "Hibernate"],
  tracingLevel: "partial",
};

/**
 * Parse Spring Boot REST controller annotations.
 * Requirement: 14.6
 */
export async function parseRestControllers(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.endsWith(".java")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const symbols: Symbol[] = [];
    
    // Extract @GetMapping, @PostMapping, etc.
    const mappingPattern = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;
    let match;
    
    while ((match = mappingPattern.exec(content)) !== null) {
      const [, method, path] = match;
      const lineNumber = content.substring(0, match.index).split("\n").length;
      
      symbols.push({
        id: `spring:mapping:${method}:${path}`,
        name: `${method.toUpperCase()} ${path}`,
        kind: "method",
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
    
    // Also extract @RequestMapping
    const requestPattern = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;
    while ((match = requestPattern.exec(content)) !== null) {
      const [, path] = match;
      const lineNumber = content.substring(0, match.index).split("\n").length;
      
      symbols.push({
        id: `spring:mapping:REQUEST:${path}`,
        name: `REQUEST ${path}`,
        kind: "method",
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
 * Parse JPA entities and Hibernate models.
 * Requirement: 14.6
 */
export async function parseJPAEntities(filePath: string, parser: Parser): Promise<Symbol[]> {
  if (!filePath.endsWith(".java")) return [];
  
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const tree = parser.parse(content);
    const ast = fromSyntaxNode(tree.rootNode);
    const symbols = extractSymbols(ast, filePath);
    
    // Filter for classes with @Entity annotation
    return symbols.filter((s: Symbol) => 
      s.kind === "class" && 
      s.signature && 
      s.signature.includes("@Entity")
    );
  } catch {
    return [];
  }
}

/**
 * Main entry point for Spring Boot parsing.
 */
export async function parseSpringBootFile(filePath: string): Promise<Symbol[]> {
  if (!filePath.endsWith(".java")) return [];
  
  const parser = new Parser();
  parser.setLanguage(Java as unknown as Parser.Language);
  
  const results = await Promise.all([
    parseRestControllers(filePath, parser),
    parseJPAEntities(filePath, parser),
  ]);
  return results.flat();
}
